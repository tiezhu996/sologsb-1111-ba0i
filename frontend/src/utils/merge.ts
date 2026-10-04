import { db } from './db';
import { footageOf, recoveryOf, checkBoxContinuity } from './recovery';
import { createBaseline } from './baseline';
import { mergeableFields, rowLabelOf } from './entityFields';
import { uid } from './id';
import type {
  CatalogSnapshot,
  EntityKind,
  HandoverPackage,
  MergeConflict,
  MergeOutcome,
} from '../types/handover';
import type { DrillRun } from '../types/drill-run';

const ENTITIES: EntityKind[] = ['holes', 'runs', 'boxes', 'lithos'];

type Row = Record<string, unknown> & { id: string };

/** 实体接口没有字符串索引签名，统一经 unknown 转 Row 供三向合并按字段名读写 */
const asRows = (rows: readonly { id: string }[]): Row[] => rows as unknown as Row[];

/** 深度值相等：数组/对象按 JSON 比对，数字按数值比对，空串与 undefined 归一 */
export function sameValue(a: unknown, b: unknown): boolean {
  const na = a === '' || a === null ? undefined : a;
  const nb = b === '' || b === null ? undefined : b;
  if (na === undefined && nb === undefined) return true;
  if (typeof na === 'number' || typeof nb === 'number') return Number(na) === Number(nb);
  if (typeof na === 'object' || typeof nb === 'object') return JSON.stringify(na ?? null) === JSON.stringify(nb ?? null);
  return String(na) === String(nb);
}

function indexRows(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((row) => [row.id, row]));
}

/** 回次进尺/采取率派生重算（起止深度或岩芯长度变化后必须调用） */
export function recomputeRunDerived(runs: DrillRun[]): DrillRun[] {
  return runs.map((run) => {
    const footage = footageOf(run.fromDepth, run.toDepth);
    const recovery = recoveryOf(run.coreLength, footage);
    if (run.footage === footage && run.recovery === recovery) return run;
    return { ...run, footage, recovery };
  });
}

interface MergeDelta {
  autoApplied: MergeOutcome['autoApplied'];
  conflicts: Array<Omit<MergeConflict, 'id' | 'handoverId' | 'createdAt' | 'status'>>;
  affectedHoleIds: Set<string>;
}

/**
 * 单实体三向合并：
 * - 现场相对基线改过、编目台未动 → 自动接入
 * - 编目台改过、现场未动 → 保留编目台
 * - 同一字段两边都改成不同值 → 记冲突（两份待处理，落库暂留编目台值）
 * - 基线中不存在的行：现场新增自动接入；两边同 id 各建则逐字段判冲突
 */
function mergeEntity(kind: EntityKind, baseline: Row[], camp: Row[], remote: Row[], handoverId: string, delta: MergeDelta): Row[] {
  const baseMap = indexRows(baseline);
  const campMap = indexRows(camp);
  const fields = mergeableFields(kind);
  const next = new Map(camp.map((row) => [row.id, { ...row }]));

  remote.forEach((remoteRow) => {
    const base = baseMap.get(remoteRow.id);
    const campRow = campMap.get(remoteRow.id);

    // 现场新增
    if (!base) {
      if (!campRow) {
        next.set(remoteRow.id, { ...remoteRow });
        delta.autoApplied.push({ entity: kind, id: remoteRow.id, action: 'added' });
        if (remoteRow.holeId) delta.affectedHoleIds.add(String(remoteRow.holeId));
        return;
      }
      // 两边各自新建撞 id：所有取值不同的字段都算两边都改过
      const conflictFields = fields.filter((f) => !sameValue(remoteRow[f.key], campRow[f.key]));
      if (conflictFields.length === 0) return;
      conflictFields.forEach((f) => {
        delta.conflicts.push({
          entity: kind,
          rowId: remoteRow.id,
          rowLabel: rowLabelOf(kind, campRow),
          holeId: String(campRow.holeId ?? ''),
          field: f.key,
          baseValue: undefined,
          campValue: campRow[f.key],
          fieldValue: remoteRow[f.key],
        });
      });
      if (campRow.holeId) delta.affectedHoleIds.add(String(campRow.holeId));
      return;
    }

    // 基线上已有的行：逐字段三向合并
    if (!campRow) {
      // 编目台把基线行删了（本应用无删除入口，防御性分支）：整行按现场恢复
      next.set(remoteRow.id, { ...remoteRow });
      delta.autoApplied.push({ entity: kind, id: remoteRow.id, action: 'updated' });
      if (remoteRow.holeId) delta.affectedHoleIds.add(String(remoteRow.holeId));
      return;
    }

    const merged: Row = { ...campRow };
    let changed = false;
    fields.forEach((f) => {
      const key = f.key;
      const bv = base[key];
      const cv = campRow[key];
      const fv = remoteRow[key];
      const remoteChanged = !sameValue(fv, bv);
      const campChanged = !sameValue(cv, bv);
      if (remoteChanged && !campChanged) {
        merged[key] = fv;
        changed = true;
      } else if (remoteChanged && campChanged && !sameValue(fv, cv)) {
        delta.conflicts.push({
          entity: kind,
          rowId: remoteRow.id,
          rowLabel: rowLabelOf(kind, campRow),
          holeId: String(campRow.holeId ?? ''),
          field: key,
          baseValue: bv,
          campValue: cv,
          fieldValue: fv,
        });
      }
    });

    if (changed) {
      next.set(remoteRow.id, merged);
      delta.autoApplied.push({ entity: kind, id: remoteRow.id, action: 'updated' });
    }
    if (delta.conflicts.some((c) => c.entity === kind && c.rowId === remoteRow.id) || changed) {
      if (campRow.holeId) delta.affectedHoleIds.add(String(campRow.holeId));
    }
  });

  return [...next.values()];
}

/**
 * 执行整批三向合并并在一个事务内落库（整批原子：任一步失败全部回滚）。
 * 调用方负责先把批次回执以 failed/pending 落库，再调用本函数；成功后回执由本函数置为 merged。
 */
export async function commitHandoverMerge(pkg: HandoverPackage, attempt: number): Promise<MergeOutcome> {
  const now = new Date().toISOString();
  const tables = [
    db.holes,
    db.runs,
    db.boxes,
    db.lithos,
    db.baselines,
    db.handovers,
    db.conflicts,
    db.meta,
  ] as const;
  // 表数量超过 Dexie 事务重载上限，经 any 走可变参数形式
  const runTransaction = db.transaction.bind(db) as unknown as (
    mode: 'rw',
    ...args: unknown[]
  ) => Promise<MergeOutcome>;
  return runTransaction(
    'rw',
    ...(tables as unknown as unknown[]),
    async () => {
      // 当前编目台（营地）数据
      const camp: CatalogSnapshot = {
        holes: await db.holes.toArray(),
        runs: await db.runs.toArray(),
        boxes: await db.boxes.toArray(),
        lithos: await db.lithos.toArray(),
      };
      const baselineSnap = pkg.baseline;

      const delta: MergeDelta = { autoApplied: [], conflicts: [], affectedHoleIds: new Set() };

      const mergedHoles = mergeEntity('holes', asRows(baselineSnap.holes), asRows(camp.holes), asRows(pkg.changes.holes), pkg.handoverId, delta);
      const mergedRuns0 = mergeEntity('runs', asRows(baselineSnap.runs), asRows(camp.runs), asRows(pkg.changes.runs), pkg.handoverId, delta);
      const mergedBoxes = mergeEntity('boxes', asRows(baselineSnap.boxes), asRows(camp.boxes), asRows(pkg.changes.boxes), pkg.handoverId, delta);
      const mergedLithos = mergeEntity('lithos', asRows(baselineSnap.lithos), asRows(camp.lithos), asRows(pkg.changes.lithos), pkg.handoverId, delta);

      // 回次变化带动进尺/采取率重算（全量重算保证一致，派生字段不参与三向比对）
      const mergedRuns = recomputeRunDerived(mergedRuns0 as unknown as DrillRun[]);

      // 岩芯箱连续性重算：合并后受影响孔上、相对基线新出现断档（或仍断档）的箱子告警
      const baselineBoxMap = indexRows(asRows(baselineSnap.boxes));
      const continuityWarnings: MergeOutcome['continuityWarnings'] = [];
      (mergedBoxes as unknown as CatalogSnapshot['boxes']).forEach((box) => {
        if (!delta.affectedHoleIds.has(box.holeId)) return;
        const after = checkBoxContinuity(box, mergedRuns as unknown as CatalogSnapshot['runs']);
        if (after.covered) return;
        const beforeBox = baselineBoxMap.get(box.id) as unknown as CatalogSnapshot['boxes'][number] | undefined;
        const before = beforeBox ? checkBoxContinuity(beforeBox, baselineSnap.runs) : undefined;
        if (before?.covered || before === undefined) {
          continuityWarnings.push({ boxId: box.id, boxNo: box.boxNo, holesId: box.holeId, message: after.message });
        }
      });

      // 冲突落库（重试时先清掉本批旧冲突）
      await db.conflicts.where('handoverId').equals(pkg.handoverId).delete();
      if (delta.conflicts.length) {
        const conflictRows: MergeConflict[] = delta.conflicts.map((c) => ({
          ...c,
          id: uid('conflict'),
          handoverId: pkg.handoverId,
          createdAt: now,
          status: 'pending',
        }));
        await db.conflicts.bulkPut(conflictRows);
      }

      // 业务数据整批替换落库
      await db.holes.clear();
      await db.runs.clear();
      await db.boxes.clear();
      await db.lithos.clear();
      await db.holes.bulkPut(mergedHoles as never[]);
      await db.runs.bulkPut(mergedRuns as never[]);
      await db.boxes.bulkPut(mergedBoxes as never[]);
      await db.lithos.bulkPut(mergedLithos as never[]);

      // 合并成功 → 当前整库推进为新的编目基线版本（与批次分开保存）
      const newBaseline = await createBaseline({
        label: `合并基线 · 批次 ${pkg.handoverId}`,
        createdBy: pkg.sealedBy || '系统',
        source: 'merge',
        handoverId: pkg.handoverId,
        snapshot: {
          holes: mergedHoles as unknown as CatalogSnapshot['holes'],
          runs: mergedRuns as unknown as CatalogSnapshot['runs'],
          boxes: mergedBoxes as unknown as CatalogSnapshot['boxes'],
          lithos: mergedLithos as unknown as CatalogSnapshot['lithos'],
        },
      });

      const outcome: MergeOutcome = {
        mergedAt: now,
        autoApplied: delta.autoApplied,
        conflictIds: delta.conflicts.map((_, i) => `${pkg.handoverId}#${i}`),
        recomputedHoleIds: [...delta.affectedHoleIds],
        continuityWarnings,
        baselineId: newBaseline.id,
        baselineVersion: newBaseline.version,
      };
      // 用真实冲突 id 回填（便于回执与冲突表对应）
      const realConflictIds = await db.conflicts.where('handoverId').equals(pkg.handoverId).primaryKeys();
      outcome.conflictIds = realConflictIds as string[];

      const receipt = await db.handovers.get(pkg.handoverId);
      if (receipt) {
        await db.handovers.put({
          ...receipt,
          status: 'merged',
          error: undefined,
          attempts: attempt,
          importedAt: now,
          result: outcome,
        });
      }

      return outcome;
    },
  );
}
