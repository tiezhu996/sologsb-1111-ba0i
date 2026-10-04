/** 断网现场交接：现场交接批次 / 编目基线版本 / 合并冲突的领域类型 */

import type { DrillHole } from './drill-hole';
import type { DrillRun } from './drill-run';
import type { CoreBox } from './core-box';
import type { LithoLog } from './litho-log';

/** 参与交接合并的实体表 */
export type EntityKind = 'holes' | 'runs' | 'boxes' | 'lithos';

export type CatalogRow = DrillHole | DrillRun | CoreBox | LithoLog;

/** 编目基线版本：离场时整库快照的只读留档（与现场交接批次分开保存） */
export interface CatalogBaseline {
  /** 基线 id，同时作为版本号，如 baseline-0001 */
  id: string;
  /** 单调递增的版本序号 */
  version: number;
  label: string;
  /** 基线创建时间 ISO */
  createdAt: string;
  /** 创建人（编目员） */
  createdBy: string;
  /** 快照整库：包内自带基线，现场/合并时无需再向营地取数 */
  snapshot: CatalogSnapshot;
  /** 来源：initial 为老数据升级回填，manual 为手工创建，merge 为合并成功后推进 */
  source: 'initial' | 'manual' | 'merge';
  /** 由哪一个现场批次合并推进而来（source=merge 时有值） */
  handoverId?: string;
}

/** 整库快照 */
export interface CatalogSnapshot {
  holes: DrillHole[];
  runs: DrillRun[];
  boxes: CoreBox[];
  lithos: LithoLog[];
}

/** 现场编辑工作集（无网现场在交接页直接改动的行），单活动会话，落库防刷新丢失 */
export interface FieldSession {
  /** 固定单例行 id */
  id: 'active';
  handoverId: string;
  rigNo: string;
  shift: string;
  sealedBy: string;
  note: string;
  baselineId: string;
  baselineLabel: string;
  /** 离场基线快照（包内带基线，现场刷新/重开后仍可据此封包） */
  baseline: CatalogSnapshot;
  createdAt: string;
  working: CatalogSnapshot;
}

/** 现场交接包文件（离场时带出、回营合并时带回；包内带上基线） */
export interface HandoverPackage {
  app: 'gbdrillcore-handover';
  /** 批次号，同批次重复导入只产生一张回执 */
  handoverId: string;
  rigNo: string;
  shift: string;
  sealedBy: string;
  note: string;
  /** 离场（建包）时间 ISO */
  createdAt: string;
  /** 封包（现场交回）时间 ISO */
  sealedAt: string;
  /** 包内自带的编目基线 */
  baselineId: string;
  baseline: CatalogSnapshot;
  /** 现场改动的行（新增 + 修改，相对 baseline diff 后生成） */
  changes: {
    holes: DrillHole[];
    runs: DrillRun[];
    boxes: CoreBox[];
    lithos: LithoLog[];
  };
}

export type HandoverStatus = 'merged' | 'failed';

/** 现场交接批次回执（每批次至多一张） */
export interface HandoverReceipt {
  id: string;
  handoverId: string;
  rigNo: string;
  shift: string;
  sealedBy: string;
  note: string;
  createdAt: string;
  sealedAt: string;
  /** 最近一次尝试导入时间 ISO（重试会刷新） */
  importedAt: string;
  baselineId: string;
  status: HandoverStatus;
  /** 整批不落库：失败原因（status=failed 时有值） */
  error?: string;
  attempts: number;
  /** 原包留档（重试无需重新选择文件） */
  pkg: HandoverPackage;
  /** 最近一次合并结果（成功时有值） */
  result?: MergeOutcome;
}

/** 一次三向合并的产物统计 */
export interface MergeOutcome {
  mergedAt: string;
  /** 一边改过、自动接入的行 id */
  autoApplied: Array<{ entity: EntityKind; id: string; action: 'added' | 'updated' }>;
  /** 同一字段两边都改过、留待处理的冲突 */
  conflictIds: string[];
  /** 合并后回次重算影响到的孔 */
  recomputedHoleIds: string[];
  /** 重算后岩芯箱连续性断档告警（回次变化带动） */
  continuityWarnings: Array<{ boxId: string; boxNo: string; holesId: string; message: string }>;
  /** 合并后推进到的新基线 id */
  baselineId: string;
  baselineVersion: number;
}

/** 字段级冲突（同一行同一字段两边都改过 → 一行可产生多条，两份待处理） */
export interface MergeConflict {
  id: string;
  handoverId: string;
  entity: EntityKind;
  rowId: string;
  /** 行的业务展示名（孔号/回次号/箱号/深度区间） */
  rowLabel: string;
  holeId: string;
  field: string;
  /** 基线值（共同祖先） */
  baseValue: unknown;
  /** 编目台（营地）值 */
  campValue: unknown;
  /** 现场值 */
  fieldValue: unknown;
  createdAt: string;
  status: 'pending' | 'resolved';
  /** 处理结果采用了哪一边 */
  resolvedTo?: 'camp' | 'field';
  resolvedAt?: string;
}
