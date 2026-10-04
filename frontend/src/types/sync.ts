import type { DrillHole } from './drill-hole';
import type { DrillRun } from './drill-run';
import type { CoreBox } from './core-box';
import type { LithoLog } from './litho-log';

/** 参与断网交接合并的四类业务表 */
export type EntityType = 'holes' | 'runs' | 'boxes' | 'lithos';

export const ENTITY_TYPES: EntityType[] = ['holes', 'runs', 'boxes', 'lithos'];

/** 实体中文名（冲突待处理与回执展示用） */
export const ENTITY_LABEL: Record<EntityType, string> = {
  holes: '钻孔',
  runs: '回次',
  boxes: '岩芯箱',
  lithos: '岩性',
};

export type EntityRecord = DrillHole | DrillRun | CoreBox | LithoLog;

/** 编目基线版本：离网前编目台四类台账的快照，作为三方合并的共同祖先 */
export interface CatalogBaseline {
  /** 基线编号（如 base-20261004-xxxx） */
  id: string;
  /** 基线建立时间 ISO */
  createdAt: string;
  /** 建立说明（如「甲班出工前基线」） */
  note: string;
  /** 建立时编目台数据快照 */
  snapshot: {
    holes: DrillHole[];
    runs: DrillRun[];
    boxes: CoreBox[];
    lithos: LithoLog[];
  };
}

/** 现场交接批次的处理状态 */
export type BatchStatus =
  | 'pending' // 批次已登记，尚未成功写入
  | 'failed' // 写入失败，整批未落库，可重试
  | 'conflicted' // 已合并非冲突部分，仍有字段冲突待处理
  | 'merged'; // 全部合并完成（无冲突或冲突已全部处理）

/** 合并回执：同一批次重复导入只返回同一张回执 */
export interface MergeReceipt {
  /** 回执编号，与批次一一对应（同批次重复导入不变） */
  id: string;
  batchId: string;
  /** 现场信息 */
  rigNo: string;
  shift: string;
  /** 批次封包时间 ISO */
  packedAt: string;
  /** 基线编号 */
  baselineId: string;
  mergedAt: string;
  /** 自动接入（仅现场改动）的字段数 */
  autoFieldCount: number;
  /** 各类目新增记录数 */
  added: Record<EntityType, number>;
  /** 各类目自动接入的记录数（至少一个字段被接入） */
  updated: Record<EntityType, number>;
  /** 各类目按现场删除生效的记录数 */
  deleted: Record<EntityType, number>;
  /** 各类目遗留的字段冲突数（两边都改过） */
  conflicts: Record<EntityType, number>;
  /** 合并后受影响钻孔的岩芯箱连续性重算结果 */
  boxContinuity: Array<{
    boxId: string;
    boxNo: string;
    holeId: string;
    covered: boolean;
    message: string;
  }>;
}

/** 现场交接批次（断网回营地后导入合并的单位） */
export interface HandoverBatch {
  /** 批次编号，现场封包时生成（重复导入据此去重） */
  id: string;
  /** 包内自带基线编号 */
  baselineId: string;
  /** 现场钻机号 */
  rigNo: string;
  /** 现场班组 */
  shift: string;
  /** 现场封包时间 ISO */
  packedAt: string;
  /** 首次导入时间 ISO */
  importedAt: string;
  /** 最后一次尝试时间 ISO */
  lastAttemptAt: string;
  status: BatchStatus;
  /** 尝试次数（含重试） */
  attempts: number;
  /** 最近一次写入失败原因（status=failed 时有值） */
  lastError?: string;
  /** 合并回执（成功合并后生成；同批次重复导入沿用） */
  receiptId?: string;
  /** 回执内容（与批次分开语义，但随批次留存便于重复导入只返回同一张回执） */
  receipt?: MergeReceipt;
  /** 尚未处理完的字段冲突数 */
  pendingConflictCount: number;
  /** 原始交接包（写入失败后原样保留以便整批重试） */
  package?: HandoverPackage;
}

/** 冲突字段的处理决定 */
export type ConflictResolution = 'camp' | 'field';

/** 字段冲突待处理项：同一字段基线之后两边都改过，留下两份待人工处理 */
export interface FieldConflict {
  id: string;
  batchId: string;
  entityType: EntityType;
  entityId: string;
  /** 冲突字段名 */
  field: string;
  /** 编目台一侧的值 */
  campValue: unknown;
  /** 现场一侧的值 */
  fieldValue: unknown;
  /** 基线原值（便于人工判断） */
  baseValue: unknown;
  status: 'pending' | 'resolved';
  /** 人工选择结果 */
  resolution?: ConflictResolution;
  resolvedAt?: string;
}

/** 现场交接包文件结构（包内自带基线，自包含可离线流转） */
export interface HandoverPackage {
  app: 'gbdrillcore-handover';
  /** 封包格式版本 */
  formatVersion: 1;
  batchId: string;
  baselineId: string;
  rigNo: string;
  shift: string;
  packedAt: string;
  /** 包内自带基线（与批次分开保存的编目基线版本） */
  baseline: {
    id: string;
    createdAt: string;
    note: string;
    snapshot: CatalogBaseline['snapshot'];
  };
  /** 现场断网期间改动后的全量记录 */
  records: CatalogBaseline['snapshot'];
  /** 现场删除的记录 id（按类目） */
  deleted: Record<EntityType, string[]>;
}

/** 合并过程中的单实体结果（内部使用） */
export interface EntityMergeResult {
  put?: EntityRecord;
  deleted?: boolean;
  /** 自动接入的字段数 */
  autoFields: string[];
  conflicts: Array<Pick<FieldConflict, 'field' | 'campValue' | 'fieldValue' | 'baseValue'>>;
  /** 是否为新增记录 */
  isNew: boolean;
}
