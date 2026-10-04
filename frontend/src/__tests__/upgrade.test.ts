/**
 * schema 升级测试：v2 老库（已有数据）→ v3 打开时自动回填为编目基线版本。
 *   npx esbuild src/__tests__/upgrade.test.ts --bundle --platform=node --format=esm --outfile=dist-test/upgrade.test.mjs
 *   node dist-test/upgrade.test.mjs
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { db, DB_NAME, META_LATEST_BASELINE } from '../utils/db';
import type { DrillRun } from '../types/drill-run';
import { footageOf, recoveryOf } from '../utils/recovery';

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string): asserts cond {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${msg}`);
  }
}

async function main(): Promise<void> {
  // 1. 先以 v2 声明建一个老库并写入历史数据
  const legacy = new Dexie(DB_NAME);
  legacy.version(2).stores({
    holes: 'id, holeNo, rigNo, shift, startDate',
    runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
    boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
    lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
    meta: 'key',
  });
  const footage = footageOf(0, 5);
  await legacy.table('runs').bulkPut([
    {
      id: 'run-old-1',
      runNo: 'old-1',
      holeId: 'hole-old',
      fromDepth: 0,
      toDepth: 5,
      footage,
      coreLength: 4.2,
      recovery: recoveryOf(4.2, footage),
      waterLevel: 0,
      shift: '甲班',
      drilledAt: '2026-08-01T00:00:00.000Z',
      recorder: '历史记录人',
    } satisfies DrillRun,
  ]);
  await legacy.table('holes').bulkPut([
    {
      id: 'hole-old',
      holeNo: 'ZK-OLD',
      coordX: 1,
      coordY: 2,
      collarElevation: 900,
      designDepth: 100,
      finalDepth: 0,
      startDate: '2026-08-01T00:00:00.000Z',
      rigNo: 'XY-1',
      shift: '甲班',
      surveyData: [],
    },
  ]);
  await legacy.close();

  // 2. 用当前 v3 的 db 打开同一个库 → 触发 upgrade
  await db.open();

  // 3. 校验业务数据仍在
  const runs = await db.runs.toArray();
  assert(runs.length === 1 && runs[0].id === 'run-old-1', '升级后原回次数据保留');
  const holes = await db.holes.toArray();
  assert(holes.length === 1 && holes[0].holeNo === 'ZK-OLD', '升级后原钻孔数据保留');

  // 4. 校验已有数据已回填为一份编目基线版本
  const baselines = await db.baselines.toArray();
  assert(baselines.length === 1, '回填生成 1 份编目基线');
  const baseline = baselines[0];
  assert(baseline.snapshot.runs.length === 1 && baseline.snapshot.runs[0].id === 'run-old-1', '基线快照含历史回次');
  assert(baseline.snapshot.holes.length === 1 && baseline.snapshot.holes[0].id === 'hole-old', '基线快照含历史钻孔');
  assert(baseline.note.includes('回填'), '基线说明标注为升级回填');
  const meta = await db.meta.get(META_LATEST_BASELINE);
  assert(meta?.value === baseline.id, 'meta 记录最新基线指向回填基线');

  // 5. 新表索引可用
  const byStatus = await db.batches.count();
  assert(byStatus === 0, 'batches 表建立且为空');
  const conflicts = await db.conflicts.count();
  assert(conflicts === 0, 'conflicts 表建立且为空');

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
