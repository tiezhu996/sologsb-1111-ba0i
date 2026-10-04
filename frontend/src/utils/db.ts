import Dexie, { type Table } from 'dexie';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { LithoLog } from '../types/litho-log';
import type { CatalogBaseline, FieldConflict, HandoverBatch } from '../types/sync';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbdrillcore-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

/** 断网合并前最后一次编目基线版本（升级回填 / 手工建基线后更新） */
export const META_LATEST_BASELINE = 'latestBaselineId';

class DrillCoreDB extends Dexie {
  holes!: Table<DrillHole, string>;
  runs!: Table<DrillRun, string>;
  boxes!: Table<CoreBox, string>;
  lithos!: Table<LithoLog, string>;
  meta!: Table<{ key: string; value: string }, string>;
  /** 编目基线版本（与现场交接批次分开保存） */
  baselines!: Table<CatalogBaseline, string>;
  /** 现场交接批次及合并回执索引 */
  batches!: Table<HandoverBatch, string>;
  /** 字段冲突待处理项 */
  conflicts!: Table<FieldConflict, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      holes: 'id, holeNo, rigNo, shift, startDate',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithos: 'id, holeId, fromDepth, toDepth, lithology',
      meta: 'key',
    });

    // v2：岩性表增加 (holeId+fromDepth) 复合索引，按深度区间查询更快；并回填历史 rqd 缺省值。
    // 升级前请在顶栏「导出备份」导出 JSON。
    this.version(2)
      .stores({
        holes: 'id, holeNo, rigNo, shift, startDate',
        runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
        boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
        lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('lithos')
          .toCollection()
          .modify((row: LithoLog) => {
            if (typeof row.rqd !== 'number') {
              row.rqd = 0;
            }
          });
      });

    // v3：断网现场交接合并。
    // - baselines：编目基线版本（离网前快照，三方合并的共同祖先）
    // - batches：现场交接批次 + 合并回执（批次与基线分开保存）
    // - conflicts：同字段两边都改的待处理项
    // 升级时把已有四类台账回填为一份「升级前编目基线」，历史数据即成为基线版本。
    this.version(3)
      .stores({
        holes: 'id, holeNo, rigNo, shift, startDate',
        runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
        boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
        lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
        meta: 'key',
        baselines: 'id, createdAt',
        batches: 'id, baselineId, status, packedAt, importedAt, receiptId',
        conflicts: 'id, batchId, entityType, entityId, status',
      })
      .upgrade(async (tx) => {
        const [holes, runs, boxes, lithos] = await Promise.all([
          tx.table<DrillHole, string>('holes').toArray(),
          tx.table<DrillRun, string>('runs').toArray(),
          tx.table<CoreBox, string>('boxes').toArray(),
          tx.table<LithoLog, string>('lithos').toArray(),
        ]);
        const baselineId = `base-upgrade-${Date.now().toString(36)}`;
        await tx.table<CatalogBaseline, string>('baselines').put({
          id: baselineId,
          createdAt: new Date().toISOString(),
          note: '升级 v3 前历史编目数据自动回填为编目基线版本',
          snapshot: { holes, runs, boxes, lithos },
        });
        await tx.table('meta').put({ key: META_LATEST_BASELINE, value: baselineId });
      });
  }
}

export const db = new DrillCoreDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
