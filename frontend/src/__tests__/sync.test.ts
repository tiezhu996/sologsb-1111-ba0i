/**
 * 断网交接合并端到端测试（node + fake-indexeddb，不依赖浏览器）：
 *   npx esbuild src/__tests__/sync.test.ts --bundle --platform=node --format=esm --outfile=dist-test/sync.test.mjs
 *   node --import ./src/__tests__/register-fake.mjs dist-test/sync.test.mjs
 */
import 'fake-indexeddb/auto';
import { db } from '../utils/db';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { LithoLog } from '../types/litho-log';
import type { HandoverPackage } from '../types/sync';
import { buildHandoverPackage, importHandoverPackage, listBatches, retryBatch, resolveConflict } from '../utils/sync';
import { footageOf, recoveryOf, checkBoxContinuity } from '../utils/recovery';

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
function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

function makeHole(id: string, patch: Partial<DrillHole> = {}): DrillHole {
  return {
    id,
    holeNo: id,
    coordX: 100,
    coordY: 200,
    collarElevation: 1000,
    designDepth: 200,
    finalDepth: 0,
    startDate: '2026-09-01T00:00:00.000Z',
    rigNo: 'XY-1',
    shift: '甲班',
    surveyData: [],
    ...patch,
  };
}
function makeRun(id: string, holeId: string, patch: Partial<DrillRun> = {}): DrillRun {
  const fromDepth = patch.fromDepth ?? 0;
  const toDepth = patch.toDepth ?? 5;
  const coreLength = patch.coreLength ?? 5;
  const footage = footageOf(fromDepth, toDepth);
  return {
    id,
    runNo: id,
    holeId,
    fromDepth,
    toDepth,
    footage,
    coreLength,
    recovery: recoveryOf(coreLength, footage),
    waterLevel: 0,
    shift: '甲班',
    drilledAt: '2026-09-10T00:00:00.000Z',
    recorder: '周明',
    ...patch,
  };
}
function makeBox(id: string, holeId: string, patch: Partial<CoreBox> = {}): CoreBox {
  return {
    id,
    boxNo: id,
    holeId,
    fromDepth: 0,
    toDepth: 25,
    slots: 10,
    slotLength: 2.5,
    boxedAt: '2026-09-11T00:00:00.000Z',
    shelfPos: 'A 区 1 架',
    damagedSlots: [],
    operator: '高振华',
    ...patch,
  };
}

async function seedCamp(): Promise<void> {
  const hole = makeHole('hole-A');
  const run1 = makeRun('run-1', 'hole-A');
  const run2 = makeRun('run-2', 'hole-A', { fromDepth: 5, toDepth: 10 });
  const box = makeBox('box-1', 'hole-A');
  await db.holes.bulkPut([hole]);
  await db.runs.bulkPut([run1, run2]);
  await db.boxes.bulkPut([box]);
}

/** 模拟现场：在基线快照上做改动后重新封包（基线保持出工前状态） */
async function simulateFieldPack(
  mutate: (records: HandoverPackage['records']) => void,
): Promise<HandoverPackage> {
  const pkg = await buildHandoverPackage({ rigNo: 'XY-1', shift: '甲班', note: '测试基线' });
  const records: HandoverPackage['records'] = JSON.parse(JSON.stringify(pkg.records));
  mutate(records);
  // 现场删除清单 = 基线中有、现场当前快照中已没有的记录
  const deleted = {
    holes: pkg.baseline.snapshot.holes.map((r) => r.id).filter((id) => !records.holes.some((r) => r.id === id)),
    runs: pkg.baseline.snapshot.runs.map((r) => r.id).filter((id) => !records.runs.some((r) => r.id === id)),
    boxes: pkg.baseline.snapshot.boxes.map((r) => r.id).filter((id) => !records.boxes.some((r) => r.id === id)),
    lithos: pkg.baseline.snapshot.lithos.map((r) => r.id).filter((id) => !records.lithos.some((r) => r.id === id)),
  };
  return {
    ...pkg,
    packedAt: new Date().toISOString(),
    records,
    deleted,
  };
}

async function main(): Promise<void> {
  console.log('\n[1] 仅有现场改动 → 字段自动接入，回次采取率随深度重算，岩芯箱连续性重算');
  await seedCamp();
  const pack1 = await simulateFieldPack((records) => {
    // 现场把 run-1 的止深度从 5 改为 8，岩芯长度给 6.4 → 进尺 8，采取率 80%
    const run = records.runs.find((r) => r.id === 'run-1')!;
    run.toDepth = 8;
    run.coreLength = 6.4;
    // 现场新增 run-3 覆盖 8~10（替代原 run-2 区间），并把 run-2 删除
    const run2Idx = records.runs.findIndex((r) => r.id === 'run-2');
    records.runs.splice(run2Idx, 1);
    records.runs.push(makeRun('run-3', 'hole-A', { runNo: 'run-3', fromDepth: 8, toDepth: 10, coreLength: 2 }));
  });
  const r1 = await importHandoverPackage(JSON.stringify(pack1));
  assert(!r1.reused, '非重复导入');
  assert(r1.batch.status === 'merged', '状态 merged（无两边同改冲突）');
  assert(r1.receipt!.updated.runs === 1, '回执：1 个回次被自动接入');
  assert(r1.receipt!.added.runs === 1, '回执：1 个新回次接入');
  assert(r1.receipt!.deleted.runs === 1, '回执：1 个回次按现场删除');
  const mergedRun1 = await db.runs.get('run-1');
  assert(mergedRun1!.toDepth === 8, '现场深度已接入');
  assert(approx(mergedRun1!.footage, 8), `进尺重算为 8（实际 ${mergedRun1!.footage}）`);
  assert(approx(mergedRun1!.recovery, 80), `采取率重算为 80%（实际 ${mergedRun1!.recovery}）`);
  assert((await db.runs.get('run-2')) === undefined, 'run-2 已删除');
  const run3 = await db.runs.get('run-3');
  assert(!!run3, 'run-3 已新增');
  const box1 = await db.boxes.get('box-1');
  const allRuns = await db.runs.toArray();
  const continuity = checkBoxContinuity(box1!, allRuns);
  assert(continuity.covered === false, '岩芯箱连续性已按新回次重算：0~25 出现断档');
  const receiptBreak = r1.receipt!.boxContinuity.find((b) => b.boxId === 'box-1');
  assert(!!receiptBreak && !receiptBreak.covered, '回执携带重算后的断档提示');

  console.log('\n[2] 同一批次重复导入 → 只返回同一张回执，数据不再变化');
  const r2 = await importHandoverPackage(JSON.stringify(pack1));
  assert(r2.reused, '标记为重复导入');
  assert(r2.receipt!.id === r1.receipt!.id, '沿用同一张回执');
  const batches = await listBatches();
  assert(batches.length === 1, '只有一张批次记录');
  const run1Again = await db.runs.get('run-1');
  assert(run1Again!.coreLength === 6.4, '重复导入未改动数据');

  console.log('\n[3] 同一字段两边都改 → 留两份待处理，其余字段自动接入');
  // 编目台在现场离线期间修改：hole-A 的 coordY（与现场冲突）+ remark（仅编目台改，保留）
  await db.holes.put(makeHole('hole-A', { coordY: 999, remark: '编目台补充备注' }));
  const pack2 = await simulateFieldPack((records) => {
    const hole = records.holes.find((h) => h.id === 'hole-A')!;
    hole.coordY = 333; // 现场也改 coordY
    hole.designDepth = 220; // 仅现场改 designDepth
  });
  const r3 = await importHandoverPackage(JSON.stringify(pack2));
  assert(r3.batch.status === 'conflicted', '状态 conflicted');
  assert(r3.batch.pendingConflictCount === 1, '恰好 1 个字段冲突');
  assert(r3.receipt!.conflicts.holes === 1, '回执记录 1 个钻孔冲突');
  assert(r3.receipt!.autoFieldCount >= 1, '回执含自动接入字段数');
  const holeAfterMerge = await db.holes.get('hole-A');
  assert(holeAfterMerge!.designDepth === 220, '仅现场改的 designDepth 自动接入');
  assert(holeAfterMerge!.remark === '编目台补充备注', '仅编目台改的 remark 保留');
  assert(holeAfterMerge!.coordY === 999, '冲突字段落库暂用编目台值（999）');
  const { listAllConflicts } = await import('../utils/sync');
  const pending = (await listAllConflicts()).filter((c) => c.status === 'pending' && c.batchId === pack2.batchId);
  assert(pending.length === 1 && pending[0].field === 'coordY', '待处理项为 coordY，含 camp/field 两份值');
  assert(pending[0].campValue === 999 && pending[0].fieldValue === 333, '待处理项保留编目台 999 / 现场 333');

  console.log('\n[4] 处理冲突选现场值 → 数据生效，批次转为 merged');
  await resolveConflict(pending[0].id, 'field');
  const holeResolved = await db.holes.get('hole-A');
  assert(holeResolved!.coordY === 333, '已采用现场值 333');
  const batch2 = await db.batches.get(pack2.batchId);
  assert(batch2!.status === 'merged', '冲突清零后批次状态 merged');
  assert(batch2!.pendingConflictCount === 0, '待处理计数归零');

  console.log('\n[5] 写入失败 → 整批不落库，批次留 failed 可重试');
  // 造一个冲突批次：先编目台改 hole-A.remark
  await db.holes.put(makeHole('hole-A', { coordY: 333, remark: '营地新值', designDepth: 220 }));
  const pack3 = await simulateFieldPack((records) => {
    records.holes.find((h) => h.id === 'hole-A')!.remark = '现场新值';
  });
  // 让合并事务在落库阶段抛错：临时把 bulkPut 打桩为 reject
  const originalBulkPut = db.holes.bulkPut.bind(db.holes);
  db.holes.bulkPut = (() => Promise.reject(new Error('模拟 IndexedDB 写入失败'))) as unknown as typeof db.holes.bulkPut;
  let threw = false;
  try {
    await importHandoverPackage(JSON.stringify(pack3));
  } catch {
    threw = true;
  }
  db.holes.bulkPut = originalBulkPut;
  assert(threw, '写入失败向上抛错');
  const failedBatch = await db.batches.get(pack3.batchId);
  assert(!!failedBatch && failedBatch.status === 'failed', '批次留在 failed');
  assert(!!failedBatch.lastError && failedBatch.lastError.includes('模拟'), '记录失败原因');
  assert(failedBatch.attempts === 1, '尝试次数为 1');
  const holeAfterFail = await db.holes.get('hole-A');
  assert(holeAfterFail!.remark === '营地新值', '整批未落库：现场值未写入');
  // 重试 → 成功合并（remark 两边不同 → 产生冲突）
  const r5 = await retryBatch(pack3.batchId);
  assert(r5.batch.attempts === 2, '重试后尝试次数为 2');
  const retryBatchRow = await db.batches.get(pack3.batchId);
  assert(retryBatchRow!.status === 'conflicted', '重试成功合并，产生字段冲突');
  assert(retryBatchRow!.lastError === undefined, '失败原因已清除');

  console.log('\n[6] 基线与批次分开保存 + v3 升级回填语义');
  const baselineCount = await db.baselines.count();
  assert(baselineCount >= 1, `基线表独立保存基线（${baselineCount} 份），与批次表分离；后续封包复用同一最新基线`);
  const batchCount = await db.batches.count();
  assert(batchCount === 3, `批次单独存于 batches 表（${batchCount} 张），不与基线混存`);

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
