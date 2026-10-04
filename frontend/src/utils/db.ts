import Dexie, { type Table } from 'dexie';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { LithoLog } from '../types/litho-log';
import type { CatalogBaseline, FieldSession, HandoverReceipt, MergeConflict } from '../types/handover';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbdrillcore-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

/** 升级回填的首个编目基线版本号与 id */
export const INITIAL_BASELINE_VERSION = 1;
export const INITIAL_BASELINE_ID = 'baseline-0001';

class DrillCoreDB extends Dexie {
  holes!: Table<DrillHole, string>;
  runs!: Table<DrillRun, string>;
  boxes!: Table<CoreBox, string>;
  lithos!: Table<LithoLog, string>;
  meta!: Table<{ key: string; value: string }, string>;
  /** 编目基线版本（与现场交接批次分开保存） */
  baselines!: Table<CatalogBaseline, string>;
  /** 现场交接批次回执 */
  handovers!: Table<HandoverReceipt, string>;
  /** 字段级冲突待处理 */
  conflicts!: Table<MergeConflict, string>;
  /** 无网现场编辑工作集（单活动会话） */
  fieldSessions!: Table<FieldSession, string>;

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

    // v3：断网现场交接合并。新增 baselines / handovers / conflicts / fieldSessions 表；
    // 已有数据升级后整体回填为首个编目基线版本（baseline-0001），之后基线与现场批次分开保存。
    this.version(3)
      .stores({
        holes: 'id, holeNo, rigNo, shift, startDate',
        runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
        boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
        lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
        meta: 'key',
        baselines: 'id, version, createdAt',
        handovers: 'id, handoverId, status, importedAt',
        conflicts: 'id, handoverId, entity, rowId, status, [entity+rowId], [handoverId+status]',
        fieldSessions: 'id',
      })
      .upgrade(async (tx) => {
        const existing = await tx.table('baselines').count();
        if (existing > 0) return;
        const [holes, runs, boxes, lithos] = await Promise.all([
          tx.table<DrillHole>('holes').toArray(),
          tx.table<DrillRun>('runs').toArray(),
          tx.table<CoreBox>('boxes').toArray(),
          tx.table<LithoLog>('lithos').toArray(),
        ]);
        const baseline: CatalogBaseline = {
          id: INITIAL_BASELINE_ID,
          version: INITIAL_BASELINE_VERSION,
          label: '升级回填基线',
          createdAt: new Date().toISOString(),
          createdBy: '系统',
          snapshot: { holes, runs, boxes, lithos },
          source: 'initial',
        };
        await tx.table('baselines').put(baseline);
        await tx.table('meta').put({ key: 'baselineSeq', value: String(INITIAL_BASELINE_VERSION) });
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
