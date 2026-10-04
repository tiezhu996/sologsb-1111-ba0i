import { db, getMeta, setMeta, INITIAL_BASELINE_ID, INITIAL_BASELINE_VERSION } from './db';
import type { CatalogBaseline, CatalogSnapshot } from '../types/handover';

/** 读取当前整库快照 */
export async function takeSnapshot(): Promise<CatalogSnapshot> {
  const [holes, runs, boxes, lithos] = await Promise.all([
    db.holes.toArray(),
    db.runs.toArray(),
    db.boxes.toArray(),
    db.lithos.toArray(),
  ]);
  return { holes, runs, boxes, lithos };
}

/** 下一个基线版本序号（持久化在 meta；缺失时以现存最大 version 兜底） */
export async function nextBaselineVersion(): Promise<number> {
  const raw = await getMeta('baselineSeq');
  if (raw && Number.isFinite(Number(raw))) return Number(raw) + 1;
  const latest = await latestBaseline();
  return (latest?.version ?? 0) + 1;
}

/** 以当前整库创建一条编目基线版本并推进版本序号 */
export async function createBaseline(input: {
  label: string;
  createdBy: string;
  source: CatalogBaseline['source'];
  handoverId?: string;
  snapshot?: CatalogSnapshot;
}): Promise<CatalogBaseline> {
  const snapshot = input.snapshot ?? (await takeSnapshot());
  const version = await nextBaselineVersion();
  const baseline: CatalogBaseline = {
    id: `baseline-${String(version).padStart(4, '0')}`,
    version,
    label: input.label.trim() || `编目基线 v${version}`,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy.trim() || '编目员',
    snapshot,
    source: input.source,
    handoverId: input.handoverId,
  };
  await db.baselines.put(baseline);
  await setMeta('baselineSeq', String(version));
  return baseline;
}

/** 最新一条基线 */
export async function latestBaseline(): Promise<CatalogBaseline | undefined> {
  const all = await db.baselines.toArray();
  return all.sort((a, b) => b.version - a.version)[0];
}

/** 按 id 取基线 */
export async function getBaseline(id: string): Promise<CatalogBaseline | undefined> {
  return db.baselines.get(id);
}

export async function listBaselines(): Promise<CatalogBaseline[]> {
  const baselines = await db.baselines.toArray();
  return baselines.sort((a, b) => b.version - a.version);
}

export { INITIAL_BASELINE_ID, INITIAL_BASELINE_VERSION };
