import { db } from './db';
import { commitHandoverMerge, recomputeRunDerived } from './merge';
import { latestBaseline } from './baseline';
import { mergeableFields } from './entityFields';
import { uid } from './id';
import type {
  CatalogRow,
  CatalogSnapshot,
  FieldSession,
  HandoverPackage,
  HandoverReceipt,
  MergeConflict,
  MergeOutcome,
} from '../types/handover';
import type { DrillRun } from '../types/drill-run';

const ENTITIES = ['holes', 'runs', 'boxes', 'lithos'] as const;

/** 校验并解析交接包文件；无法识别批次号（连 handoverId 都没有）时抛错 */
export function parseHandover(text: string): HandoverPackage {
  let raw: Partial<HandoverPackage>;
  try {
    raw = JSON.parse(text) as Partial<HandoverPackage>;
  } catch {
    throw new Error('文件不是合法 JSON');
  }
  if (!raw || raw.app !== 'gbdrillcore-handover') {
    throw new Error('交接包标记不匹配（缺少 app=gbdrillcore-handover）');
  }
  if (!raw.handoverId || typeof raw.handoverId !== 'string') {
    throw new Error('交接包缺少批次号（handoverId），无法登记回执');
  }
  for (const key of ['baseline', 'changes'] as const) {
    if (!raw[key] || typeof raw[key] !== 'object') {
      throw new Error(`交接包缺少 ${key} 段`);
    }
  }
  for (const key of ENTITIES) {
    for (const seg of ['baseline', 'changes'] as const) {
      const rows = (raw[seg] as Partial<CatalogSnapshot>)[key];
      if (!Array.isArray(rows)) {
        throw new Error(`交接包 ${seg}.${key} 段格式不正确`);
      }
    }
  }
  return raw as HandoverPackage;
}

export interface ImportHandoverResult {
  status: 'merged' | 'failed' | 'duplicate';
  receipt: HandoverReceipt;
  outcome?: MergeOutcome;
}

/**
 * 尝试合并：先把回执以 failed 落一条独立事务（合并事务随后可整体回滚而不带走回执），
 * 成功后回执在合并事务内置为 merged。
 */
async function attemptMerge(pkg: HandoverPackage, existing: HandoverReceipt | undefined): Promise<ImportHandoverResult> {
  const attempt = (existing?.attempts ?? 0) + 1;
  const now = new Date().toISOString();
  const pending: HandoverReceipt = {
    id: pkg.handoverId,
    handoverId: pkg.handoverId,
    rigNo: pkg.rigNo ?? '',
    shift: pkg.shift ?? '',
    sealedBy: pkg.sealedBy ?? '',
    note: pkg.note ?? '',
    createdAt: pkg.createdAt ?? now,
    sealedAt: pkg.sealedAt ?? now,
    importedAt: now,
    baselineId: pkg.baselineId ?? '',
    status: 'failed',
    error: '合并进行中…',
    attempts: attempt,
    pkg,
  };
  // 独立事务先落待处理：之后合并事务整批回滚时，批次仍留在待处理可重试，业务数据整批不落库
  await db.handovers.put(pending);

  try {
    const outcome = await commitHandoverMerge(pkg, attempt);
    return { status: 'merged', receipt: (await db.handovers.get(pkg.handoverId))!, outcome };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.handovers.put({ ...pending, status: 'failed', error: message, importedAt: new Date().toISOString() });
    return { status: 'failed', receipt: (await db.handovers.get(pkg.handoverId))! };
  }
}

/** 导入现场交接包：同批次重复导入只留一张回执；已合并再导入直接回原回执，不重复落数据 */
export async function importHandover(text: string): Promise<ImportHandoverResult> {
  const pkg = parseHandover(text);
  const existing = await db.handovers.get(pkg.handoverId);
  if (existing?.status === 'merged' && existing.result) {
    return { status: 'duplicate', receipt: existing, outcome: existing.result };
  }
  return attemptMerge(pkg, existing);
}

/** 失败批次重试（原包留档，无需重新选择文件） */
export async function retryHandover(handoverId: string): Promise<ImportHandoverResult> {
  const receipt = await db.handovers.get(handoverId);
  if (!receipt) throw new Error('待处理批次不存在');
  if (receipt.status === 'merged' && receipt.result) {
    return { status: 'duplicate', receipt, outcome: receipt.result };
  }
  return attemptMerge(receipt.pkg, receipt);
}

export async function listHandovers(): Promise<HandoverReceipt[]> {
  const rows = await db.handovers.toArray();
  return rows.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export async function listPendingConflicts(): Promise<MergeConflict[]> {
  const rows = await db.conflicts.toArray();
  return rows
    .filter((c) => c.status === 'pending')
    .sort((a, b) => a.entity.localeCompare(b.entity) || a.rowId.localeCompare(b.rowId) || a.field.localeCompare(b.field));
}

// ── 无网现场工作集 ────────────────────────────────────────────────────────────

/** 离场建批次：以当前最新编目基线（包内带基线）初始化现场工作集 */
export async function startFieldSession(input: { rigNo: string; shift: string; sealedBy: string; note: string }): Promise<FieldSession> {
  const active = await db.fieldSessions.get('active');
  if (active) throw new Error('已有一个未封包的现场批次，请先封包交回或放弃');
  const baseline = await latestBaseline();
  if (!baseline) throw new Error('尚无编目基线，请先在编目基线页创建基线');
  const now = new Date().toISOString();
  const session: FieldSession = {
    id: 'active',
    handoverId: uid('hd'),
    rigNo: input.rigNo,
    shift: input.shift,
    sealedBy: input.sealedBy,
    note: input.note,
    baselineId: baseline.id,
    baselineLabel: baseline.label,
    baseline: JSON.parse(JSON.stringify(baseline.snapshot)) as CatalogSnapshot,
    createdAt: now,
    working: JSON.parse(JSON.stringify(baseline.snapshot)) as CatalogSnapshot,
  };
  await db.fieldSessions.put(session);
  return session;
}

export async function getFieldSession(): Promise<FieldSession | undefined> {
  return db.fieldSessions.get('active');
}

export async function saveFieldSession(session: FieldSession): Promise<void> {
  // 回次行一经改动，进尺/采取率在工作集内同步重算
  const working: CatalogSnapshot = {
    ...session.working,
    runs: recomputeRunDerived(session.working.runs as DrillRun[]) as CatalogSnapshot['runs'],
  };
  await db.fieldSessions.put({ ...session, working });
}

export async function abandonFieldSession(): Promise<void> {
  await db.fieldSessions.delete('active');
}

/** 行是否相对基线发生改动（新增或任一可合并字段不同） */
function rowChanged(kind: (typeof ENTITIES)[number], row: Record<string, unknown>, base: Map<string, Record<string, unknown>>): boolean {
  if (!base.has(String(row.id))) return true;
  const baselineRow = base.get(String(row.id))!;
  return mergeableFields(kind).some((f) => JSON.stringify(row[f.key] ?? null) !== JSON.stringify(baselineRow[f.key] ?? null));
}

/** 封包：相对基线 diff 出现场改动，回次派生字段重算后随包带回 */
export function sealHandoverPackage(session: FieldSession): HandoverPackage {
  const changes: { [K in (typeof ENTITIES)[number]]: CatalogRow[] } = { holes: [], runs: [], boxes: [], lithos: [] };
  ENTITIES.forEach((kind) => {
    const baseMap = new Map<string, Record<string, unknown>>(
      session.baseline[kind].map((r) => [String((r as { id: string }).id), r as unknown as Record<string, unknown>]),
    );
    changes[kind] = session.working[kind].filter((row) =>
      rowChanged(kind, row as unknown as Record<string, unknown>, baseMap),
    );
  });

  return {
    app: 'gbdrillcore-handover',
    handoverId: session.handoverId,
    rigNo: session.rigNo,
    shift: session.shift,
    sealedBy: session.sealedBy,
    note: session.note,
    createdAt: session.createdAt,
    sealedAt: new Date().toISOString(),
    baselineId: session.baselineId,
    baseline: session.baseline,
    changes: {
      holes: changes.holes as unknown as HandoverPackage['changes']['holes'],
      runs: recomputeRunDerived(changes.runs as unknown as DrillRun[]) as HandoverPackage['changes']['runs'],
      boxes: changes.boxes as unknown as HandoverPackage['changes']['boxes'],
      lithos: changes.lithos as unknown as HandoverPackage['changes']['lithos'],
    },
  };
}

/** 封包并清除现场会话 */
export async function sealAndClear(session: FieldSession): Promise<HandoverPackage> {
  const pkg = sealHandoverPackage(session);
  await db.fieldSessions.delete('active');
  return pkg;
}

// ── 冲突处理 ──────────────────────────────────────────────────────────────────

/** 采用某一边解决单条字段冲突；改到回次行时同步重算进尺/采取率 */
export async function resolveConflict(conflictId: string, to: 'camp' | 'field'): Promise<void> {
  await db.transaction('rw', db.conflicts, db.holes, db.runs, db.boxes, db.lithos, async () => {
    const conflict = await db.conflicts.get(conflictId);
    if (!conflict || conflict.status === 'resolved') return;
    const table = db[conflict.entity];
    const existing = await table.get(conflict.rowId);
    if (existing) {
      const writable: Record<string, unknown> = { ...(existing as unknown as Record<string, unknown>) };
      writable[conflict.field] = to === 'field' ? conflict.fieldValue : conflict.campValue;
      const nextRow = conflict.entity === 'runs'
        ? recomputeRunDerived([writable as unknown as DrillRun])[0]
        : writable;
      await table.put(nextRow as never);
    }
    await db.conflicts.put({ ...conflict, status: 'resolved', resolvedTo: to, resolvedAt: new Date().toISOString() });
  });
}

/** 批量解决冲突（全部采用现场值 / 全部保留编目台值） */
export async function resolveConflicts(ids: string[], to: 'camp' | 'field'): Promise<void> {
  for (const id of ids) {
    // 逐条走事务，避免一条坏数据阻断整批处理
    // eslint-disable-next-line no-await-in-loop
    await resolveConflict(id, to);
  }
}
