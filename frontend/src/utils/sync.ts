import type { Table } from 'dexie';
import { db, META_LATEST_BASELINE } from './db';
import { uid } from './id';
import type { CoreBox } from '../types/core-box';
import type { DrillRun } from '../types/drill-run';
import type {
  CatalogBaseline,
  EntityRecord,
  EntityType,
  FieldConflict,
  HandoverBatch,
  HandoverPackage,
  MergeReceipt,
} from '../types/sync';
import { ENTITY_TYPES as ENTITY_TYPES_VALUES } from '../types/sync';
import { checkBoxContinuity, footageOf, recoveryOf } from './recovery';
import { mergeEntity, RECORD_DELETED_FIELD } from './syncFields';

type Snapshot = CatalogBaseline['snapshot'];

const TABLES: Record<EntityType, Table<EntityRecord, string>> = {
  holes: db.holes as Table<EntityRecord, string>,
  runs: db.runs as Table<EntityRecord, string>,
  boxes: db.boxes as Table<EntityRecord, string>,
  lithos: db.lithos as Table<EntityRecord, string>,
};

function emptyCounts(): Record<EntityType, number> {
  return { holes: 0, runs: 0, boxes: 0, lithos: 0 };
}

function readAllTables(): Promise<Snapshot> {
  return Promise.all([
    db.holes.toArray(),
    db.runs.toArray(),
    db.boxes.toArray(),
    db.lithos.toArray(),
  ]).then(([holes, runs, boxes, lithos]) => ({ holes, runs, boxes, lithos })) as Promise<Snapshot>;
}

/** 建立编目基线版本：对四类台账打快照，与现场交接批次分开保存 */
export async function createBaseline(note: string): Promise<CatalogBaseline> {
  const snapshot = await readAllTables();
  const baseline: CatalogBaseline = {
    id: uid('base'),
    createdAt: new Date().toISOString(),
    note: note.trim() || '出工前编目基线',
    snapshot,
  };
  await db.transaction('rw', db.baselines, db.meta, async () => {
    await db.baselines.put(baseline);
    await db.meta.put({ key: META_LATEST_BASELINE, value: baseline.id });
  });
  return baseline;
}

export async function listBaselines(): Promise<CatalogBaseline[]> {
  return db.baselines.orderBy('createdAt').reverse().toArray();
}

export async function getLatestBaseline(): Promise<CatalogBaseline | undefined> {
  const id = await db.meta.get(META_LATEST_BASELINE);
  if (id?.value) {
    const baseline = await db.baselines.get(id.value);
    if (baseline) return baseline;
  }
  return undefined;
}

/**
 * 现场封包：以编目基线为共同祖先，带上断网期间的全量记录与删除清单。
 * 没有基线时先按当前编目台建立一份（保证包内必带基线）。
 */
export async function buildHandoverPackage(input: { rigNo: string; shift: string; note?: string }): Promise<HandoverPackage> {
  let baseline = await getLatestBaseline();
  if (!baseline) {
    baseline = await createBaseline(input.note ?? '首次出工，按当前编目台建立基线');
  }
  const records = await readAllTables();

  const deleted = emptyCounts() as unknown as Record<EntityType, string[]>;
  ENTITY_TYPES_VALUES.forEach((type) => {
    const currentIds = new Set(records[type].map((r) => r.id));
    deleted[type] = baseline!.snapshot[type].map((r) => r.id).filter((id) => !currentIds.has(id));
  });

  return {
    app: 'gbdrillcore-handover',
    formatVersion: 1,
    batchId: uid('batch'),
    baselineId: baseline.id,
    rigNo: input.rigNo.trim(),
    shift: input.shift.trim(),
    packedAt: new Date().toISOString(),
    baseline: {
      id: baseline.id,
      createdAt: baseline.createdAt,
      note: baseline.note,
      snapshot: baseline.snapshot,
    },
    records,
    deleted,
  };
}

export function validatePackage(payload: unknown): HandoverPackage {
  const pkg = payload as Partial<HandoverPackage> | null;
  if (!pkg || typeof pkg !== 'object') throw new Error('文件不是有效的 JSON');
  if (pkg.app !== 'gbdrillcore-handover') {
    throw new Error('交接包格式不匹配（缺少 app=gbdrillcore-handover 标记）');
  }
  if (pkg.formatVersion !== 1) {
    throw new Error(`不支持的交接包版本：${String(pkg.formatVersion)}`);
  }
  if (!pkg.batchId) throw new Error('交接包缺少批次编号 batchId');
  if (!pkg.baseline?.id || !pkg.baseline.snapshot) {
    throw new Error('交接包缺少自带编目基线（baseline）');
  }
  if (!pkg.records) throw new Error('交接包缺少现场记录（records）');
  for (const type of ENTITY_TYPES_VALUES) {
    if (!Array.isArray(pkg.records[type])) throw new Error(`交接包现场记录缺少 ${type} 数组`);
    if (pkg.baseline.snapshot[type] && !Array.isArray(pkg.baseline.snapshot[type])) {
      throw new Error(`交接包基线缺少 ${type} 数组`);
    }
  }
  return pkg as HandoverPackage;
}

/** 合并后回次重算：起止深度变化带动进尺、岩芯长度带动采取率 */
function recomputeRun(record: EntityRecord): EntityRecord {
  const run = record as DrillRun;
  const footage = footageOf(run.fromDepth, run.toDepth);
  return {
    ...run,
    footage,
    recovery: recoveryOf(run.coreLength, footage),
  } as EntityRecord;
}

function indexById(records: EntityRecord[] | undefined): Map<string, EntityRecord> {
  return new Map((records ?? []).map((r) => [r.id, r]));
}

export interface ImportOutcome {
  /** true 表示同批次已导入过，直接沿用原回执，未再写任何数据 */
  reused: boolean;
  batch: HandoverBatch;
  receipt?: MergeReceipt;
}

/**
 * 导入现场交接批次并三方合并。
 *
 * 幂等：同一 batchId 已成功（merged/conflicted）→ 只返回原回执，不重复落库；
 * 失败（failed/pending）→ 走重试路径。
 *
 * 原子：批次登记与基线保存先提交；合并在单个事务内整批落库，
 * 任一步失败事务回滚，整批不落库，批次留在 failed 待处理，可重试。
 */
export async function importHandoverPackage(text: string): Promise<ImportOutcome> {
  const pkg = validatePackage(JSON.parse(text));
  const existing = await db.batches.get(pkg.batchId);

  if (existing && (existing.status === 'merged' || existing.status === 'conflicted')) {
    return { reused: true, batch: existing, receipt: existing.receipt };
  }
  return runMerge(pkg, existing);
}

/** 失败批次重试（整批重放：上次事务已回滚，业务库没有残留） */
export async function retryBatch(batchId: string): Promise<ImportOutcome> {
  const batch = await db.batches.get(batchId);
  if (!batch) throw new Error('批次不存在');
  if (batch.status === 'merged' || batch.status === 'conflicted') {
    return { reused: true, batch, receipt: batch.receipt };
  }
  const pkg = batch.package;
  if (!pkg) throw new Error('批次缺少原始交接包，无法重试');
  return runMerge(pkg, batch);
}

/** 登记批次（pending）+ 保存自带基线。先于合并事务提交，失败后批次仍留在待处理 */
async function registerBatch(pkg: HandoverPackage, previous?: HandoverBatch): Promise<HandoverBatch> {
  const now = new Date().toISOString();
  const batch: HandoverBatch = previous
    ? {
        ...previous,
        status: 'pending',
        attempts: previous.attempts + 1,
        lastAttemptAt: now,
        lastError: undefined,
      }
    : {
        id: pkg.batchId,
        baselineId: pkg.baseline.id,
        rigNo: pkg.rigNo,
        shift: pkg.shift,
        packedAt: pkg.packedAt,
        importedAt: now,
        lastAttemptAt: now,
        status: 'pending',
        attempts: 1,
        pendingConflictCount: 0,
        package: pkg,
      };

  await db.transaction('rw', db.baselines, db.batches, async () => {
    const savedBaseline = await db.baselines.get(pkg.baseline.id);
    if (!savedBaseline) {
      await db.baselines.put({
        id: pkg.baseline.id,
        createdAt: pkg.baseline.createdAt,
        note: pkg.baseline.note,
        snapshot: pkg.baseline.snapshot,
      });
    }
    await db.batches.put(batch);
  });
  return batch;
}

async function markFailed(batch: HandoverBatch, error: Error): Promise<HandoverBatch> {
  const failed: HandoverBatch = {
    ...batch,
    status: 'failed',
    lastAttemptAt: new Date().toISOString(),
    lastError: error.message,
  };
  await db.batches.put(failed);
  return failed;
}

async function runMerge(pkg: HandoverPackage, previous?: HandoverBatch): Promise<ImportOutcome> {
  const registered = await registerBatch(pkg, previous);

  try {
    const outcome = await db.transaction(
      'rw',
      [db.holes, db.runs, db.boxes, db.lithos, db.batches, db.conflicts],
      async () => {
        const added = emptyCounts();
        const updated = emptyCounts();
        const deletedCount = emptyCounts();
        const conflictCounts = emptyCounts();
        let autoFieldCount = 0;
        const newConflicts: FieldConflict[] = [];
        const affectedHoleIds = new Set<string>();

        for (const type of ENTITY_TYPES_VALUES) {
          const table = TABLES[type];
          const baseMap = baseMapsLocal(type, pkg);
          const fieldMap = fieldMapsLocal(type, pkg);
          const campMap = indexById(await table.toArray());
          const ids = new Set<string>([...baseMap.keys(), ...fieldMap.keys(), ...campMap.keys()]);

          const puts: EntityRecord[] = [];
          const deletes: string[] = [];

          for (const id of ids) {
            const base = baseMap.get(id);
            const field = fieldMap.get(id);
            const camp = campMap.get(id);

            const result = mergeEntity(type, base, field, camp);

            if (result.deleted) {
              deletes.push(id);
              deletedCount[type] += 1;
              markAffected(type, camp ?? base, affectedHoleIds);
              continue;
            }
            if (!result.put) continue;
            if (!result.isNew && result.autoFields.length === 0 && result.conflicts.length === 0) {
              continue; // 三方一致，无变化
            }

            const record = type === 'runs' ? recomputeRun(result.put) : result.put;

            if (result.isNew) {
              added[type] += 1;
            } else {
              updated[type] += 1;
            }
            autoFieldCount += result.autoFields.length;
            result.conflicts.forEach((spec) => {
              newConflicts.push({
                id: uid('conflict'),
                batchId: pkg.batchId,
                entityType: type,
                entityId: id,
                field: spec.field,
                campValue: spec.campValue,
                fieldValue: spec.fieldValue,
                baseValue: spec.baseValue,
                status: 'pending',
              });
              conflictCounts[type] += 1;
            });

            puts.push(record);
            markAffected(type, field ?? camp ?? base, affectedHoleIds);
          }

          if (puts.length) await table.bulkPut(puts as never[]);
          if (deletes.length) await table.bulkDelete(deletes);
        }

        if (newConflicts.length) await db.conflicts.bulkPut(newConflicts);

        // 合并后岩芯箱连续性重算：凡受影响钻孔下的箱子全部按新回次重新校验
        const boxContinuity: MergeReceipt['boxContinuity'] = [];
        if (affectedHoleIds.size) {
          const allRuns = await db.runs.toArray();
          const affectedBoxes = await db.boxes.where('holeId').anyOf([...affectedHoleIds]).toArray();
          affectedBoxes
            .sort((a, b) => a.boxNo.localeCompare(b.boxNo))
            .forEach((box) => {
              const result = checkBoxContinuity(box, allRuns);
              boxContinuity.push({
                boxId: box.id,
                boxNo: box.boxNo,
                holeId: box.holeId,
                covered: result.covered,
                message: result.message,
              });
            });
        }

        const now = new Date().toISOString();
        const receipt: MergeReceipt = {
          id: `rcpt-${pkg.batchId.replace(/^batch-/, '')}`,
          batchId: pkg.batchId,
          rigNo: pkg.rigNo,
          shift: pkg.shift,
          packedAt: pkg.packedAt,
          baselineId: pkg.baseline.id,
          mergedAt: now,
          autoFieldCount,
          added,
          updated,
          deleted: deletedCount,
          conflicts: conflictCounts,
          boxContinuity,
        };

        const mergedBatch: HandoverBatch = {
          ...registered,
          status: newConflicts.length > 0 ? 'conflicted' : 'merged',
          lastAttemptAt: now,
          lastError: undefined,
          receiptId: receipt.id,
          receipt,
          pendingConflictCount: newConflicts.length,
        };
        await db.batches.put(mergedBatch);
        return { batch: mergedBatch, receipt };
      },
    );

    return { reused: false, ...outcome };
  } catch (error) {
    // 事务已整体回滚（整批不落库），批次留在 failed 待处理，可重试
    const failed = await markFailed(registered, error as Error);
    throw Object.assign(error as Error, { batch: failed });
  }
}

// runMerge 内需要按类目取基线/现场 map（pkg 快照为自包含数据）
function baseMapsLocal(type: EntityType, pkg: HandoverPackage): Map<string, EntityRecord> {
  return indexById(pkg.baseline.snapshot[type] as EntityRecord[]);
}
function fieldMapsLocal(type: EntityType, pkg: HandoverPackage): Map<string, EntityRecord> {
  return indexById(pkg.records[type] as EntityRecord[]);
}

function markAffected(type: EntityType, record: EntityRecord | undefined, holeIds: Set<string>): void {
  if (!record) return;
  if (type === 'holes') {
    holeIds.add(record.id);
  } else {
    const holeId = (record as DrillRun | CoreBox).holeId;
    if (holeId) holeIds.add(holeId);
  }
}

/** 冲突处理后重算单个回次的采取率 */
async function applyRunDerived(entityId: string): Promise<void> {
  const run = await db.runs.get(entityId);
  if (run) {
    const footage = footageOf(run.fromDepth, run.toDepth);
    await db.runs.put({ ...run, footage, recovery: recoveryOf(run.coreLength, footage) });
  }
}

/** 取一个批次（或全部未决）批次下，受影响钻孔的箱子连续性重算结果 */
export async function recomputeAffectedBoxContinuity(holeIds: string[]): Promise<MergeReceipt['boxContinuity']> {
  if (!holeIds.length) return [];
  const allRuns = await db.runs.toArray();
  const boxes = await db.boxes.where('holeId').anyOf(holeIds).toArray();
  return boxes
    .sort((a, b) => a.boxNo.localeCompare(b.boxNo))
    .map((box) => {
      const result = checkBoxContinuity(box, allRuns);
      return { boxId: box.id, boxNo: box.boxNo, holeId: box.holeId, covered: result.covered, message: result.message };
    });
}

export interface ResolveOutcome {
  batch: HandoverBatch;
  continuity: MergeReceipt['boxContinuity'];
}

/**
 * 人工处理字段冲突（二选一：编目台值 / 现场值）。
 * 处理后回次采取率、岩芯箱连续性随之重算；批次冲突清零时自动置为 merged。
 */
export async function resolveConflict(conflictId: string, resolution: 'camp' | 'field'): Promise<ResolveOutcome> {
  const conflict = await db.conflicts.get(conflictId);
  if (!conflict) throw new Error('冲突项不存在');
  if (conflict.status === 'resolved') throw new Error('该冲突已处理');

  const affectedHoleIds: string[] = [];

  await db.transaction('rw', TABLES[conflict.entityType], db.runs, db.conflicts, db.batches, async () => {
    const table = TABLES[conflict.entityType];

    if (conflict.field === RECORD_DELETED_FIELD) {
      if (resolution === 'field') {
        const record = conflict.fieldValue as EntityRecord | null;
        if (record) {
          await table.put(conflict.entityType === 'runs' ? (recomputeRun(record) as never) : (record as never));
        }
      } else {
        // 选编目台：campValue 为 null 表示编目台已删 → 删除；否则保留编目台版本
        if (conflict.campValue == null) {
          await table.delete(conflict.entityId);
        } else {
          const record = conflict.campValue as EntityRecord;
          await table.put(conflict.entityType === 'runs' ? (recomputeRun(record) as never) : (record as never));
        }
      }
    } else {
      const current = await table.get(conflict.entityId);
      if (current) {
        const next = {
          ...(current as unknown as Record<string, unknown>),
          [conflict.field]: resolution === 'field' ? conflict.fieldValue : conflict.campValue,
        } as unknown as EntityRecord;
        await table.put(next as never);
      }
    }

    if (conflict.entityType === 'runs') {
      await applyRunDerived(conflict.entityId);
    }

    await db.conflicts.put({
      ...conflict,
      status: 'resolved',
      resolution,
      resolvedAt: new Date().toISOString(),
    });

    if (conflict.entityType === 'holes') {
      affectedHoleIds.push(conflict.entityId);
    } else if (conflict.field === RECORD_DELETED_FIELD) {
      for (const candidate of [conflict.fieldValue, conflict.campValue]) {
        const holeId = (candidate as DrillRun | CoreBox | null)?.holeId;
        if (holeId) affectedHoleIds.push(holeId);
      }
    } else {
      // 普通字段冲突：以落库后的最新记录定位钻孔（冲突字段为 holeId 时新值已生效）
      const latest = await TABLES[conflict.entityType].get(conflict.entityId);
      const holeId = (latest as DrillRun | CoreBox | undefined)?.holeId;
      if (holeId) affectedHoleIds.push(holeId);
    }

    const remaining = await db.conflicts.where('batchId').equals(conflict.batchId).and((c) => c.status === 'pending').count();
    const batch = await db.batches.get(conflict.batchId);
    if (batch) {
      const updated: HandoverBatch = {
        ...batch,
        pendingConflictCount: remaining,
        status: remaining === 0 ? 'merged' : 'conflicted',
      };
      if (updated.receipt) {
        updated.receipt = { ...updated.receipt, conflicts: { ...updated.receipt.conflicts } };
        updated.receipt.conflicts[conflict.entityType] = Math.max(0, updated.receipt.conflicts[conflict.entityType] - 1);
      }
      await db.batches.put(updated);
    }
  });

  const continuity = await recomputeAffectedBoxContinuity([...new Set(affectedHoleIds)]);

  // 以重算结果刷新回执中的连续性明细
  const batch = await db.batches.get(conflict.batchId);
  if (batch?.receipt && continuity.length) {
    const byId = new Map(continuity.map((c) => [c.boxId, c]));
    const replaced = new Set(continuity.map((c) => c.boxId));
    const kept = batch.receipt.boxContinuity.filter((c) => !replaced.has(c.boxId));
    const refreshedReceipt: MergeReceipt = { ...batch.receipt, boxContinuity: [...kept, ...Array.from(byId.values())] };
    await db.batches.put({ ...batch, receipt: refreshedReceipt });
    return { batch: (await db.batches.get(conflict.batchId))!, continuity };
  }

  return { batch: (await db.batches.get(conflict.batchId))!, continuity };
}

export async function listBatches(): Promise<HandoverBatch[]> {
  return db.batches.orderBy('importedAt').reverse().toArray();
}

export async function listPendingConflicts(batchId?: string): Promise<FieldConflict[]> {
  const collection = batchId
    ? db.conflicts.where('batchId').equals(batchId)
    : db.conflicts.orderBy('batchId');
  const rows = await collection.toArray();
  return rows.filter((c) => c.status === 'pending');
}

export async function listAllConflicts(): Promise<FieldConflict[]> {
  return db.conflicts.toArray();
}
