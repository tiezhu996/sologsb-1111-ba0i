import type { EntityRecord, EntityType } from '../types/sync';

/** 记录级冲突的虚拟字段名：一方删除整记录、另一方修改了它 */
export const RECORD_DELETED_FIELD = '__recordDeleted__';

/** 各实体参与合并的字段（顺序即冲突界面的展示顺序） */
export const ENTITY_FIELDS: Record<EntityType, string[]> = {
  holes: [
    'holeNo',
    'coordX',
    'coordY',
    'collarElevation',
    'designDepth',
    'finalDepth',
    'startDate',
    'endDate',
    'rigNo',
    'shift',
    'surveyData',
    'remark',
  ],
  runs: [
    'runNo',
    'holeId',
    'fromDepth',
    'toDepth',
    'coreLength',
    'waterLevel',
    'shift',
    'drilledAt',
    'recorder',
    'remark',
    // footage / recovery 为派生字段，不参与三方比较，合并后统一按深度重算
  ],
  boxes: [
    'boxNo',
    'holeId',
    'fromDepth',
    'toDepth',
    'slots',
    'slotLength',
    'boxedAt',
    'shelfPos',
    'damagedSlots',
    'operator',
    'remark',
  ],
  lithos: [
    'holeId',
    'fromDepth',
    'toDepth',
    'lithology',
    'color',
    'alteration',
    'mineralization',
    'rqd',
    'sampleNo',
    'logger',
    'remark',
  ],
};

/** 字段中文名（冲突待处理展示） */
export const FIELD_LABEL: Record<EntityType, Record<string, string>> = {
  holes: {
    holeNo: '孔号',
    coordX: '坐标 X',
    coordY: '坐标 Y',
    collarElevation: '孔口标高',
    designDepth: '设计孔深',
    finalDepth: '终孔深度',
    startDate: '开孔日期',
    endDate: '终孔日期',
    rigNo: '钻机号',
    shift: '施工班组',
    surveyData: '测斜数据',
    remark: '备注',
    [RECORD_DELETED_FIELD]: '整条记录',
  },
  runs: {
    runNo: '回次号',
    holeId: '所属钻孔',
    fromDepth: '起深度',
    toDepth: '止深度',
    coreLength: '岩芯长度',
    waterLevel: '回次水位',
    shift: '班次',
    drilledAt: '钻进日期',
    recorder: '记录人',
    remark: '备注',
    [RECORD_DELETED_FIELD]: '整条记录',
  },
  boxes: {
    boxNo: '箱号',
    holeId: '所属钻孔',
    fromDepth: '起始深度',
    toDepth: '终止深度',
    slots: '格数',
    slotLength: '每格长度',
    boxedAt: '装箱日期',
    shelfPos: '库架位',
    damagedSlots: '破损格',
    operator: '装箱人',
    remark: '备注',
    [RECORD_DELETED_FIELD]: '整条记录',
  },
  lithos: {
    holeId: '所属钻孔',
    fromDepth: '起始深度',
    toDepth: '终止深度',
    lithology: '岩性',
    color: '颜色',
    alteration: '蚀变',
    mineralization: '矿化',
    rqd: 'RQD',
    sampleNo: '样品号',
    logger: '编录人',
    remark: '备注',
    [RECORD_DELETED_FIELD]: '整条记录',
  },
};

/** 深度结构化相等（测斜点数组、破损格数组等需按内容比较） */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function fieldValue(record: EntityRecord, field: string): unknown {
  return (record as unknown as Record<string, unknown>)[field];
}

export interface FieldConflictSpec {
  field: string;
  campValue: unknown;
  fieldValue: unknown;
  baseValue: unknown;
}

export interface EntityMergeOutput {
  put?: EntityRecord;
  deleted?: boolean;
  /** 自动接入（仅一方改动）的字段名 */
  autoFields: string[];
  conflicts: FieldConflictSpec[];
  /** 现场新增的记录 */
  isNew: boolean;
}

function recordChanged(type: EntityType, record: EntityRecord, base: EntityRecord): boolean {
  return ENTITY_FIELDS[type].some((f) => !deepEqual(fieldValue(record, f), fieldValue(base, f)));
}

/**
 * 单实体三方合并（基线 base / 现场 field / 编目台 camp；缺省表示该侧已删除或不存在）：
 * - 字段只有一方相对基线改过 → 自动接入该方的值；
 * - 两边都改过且值相同 → 该值生效，不算冲突；
 * - 两边都改过且值不同 → 留两份（campValue / fieldValue）进待处理，落库记录暂用编目台值占位；
 * - 一方删除整条记录、另一方修改 → 生成记录级冲突（RECORD_DELETED_FIELD），人工二选一。
 */
export function mergeEntity(
  type: EntityType,
  base: EntityRecord | undefined,
  field: EntityRecord | undefined,
  camp: EntityRecord | undefined,
): EntityMergeOutput {
  /* ---- 基线没有该记录：离线新增 ---- */
  if (!base) {
    if (field && camp) {
      // 两侧以同一 id 各自新增：逐字段比较，不同则冲突
      const merged: Record<string, unknown> = { ...(camp as unknown as Record<string, unknown>) };
      const autoFields: string[] = [];
      const conflicts: FieldConflictSpec[] = [];
      ENTITY_FIELDS[type].forEach((f) => {
        const fv = fieldValue(field, f);
        const cv = fieldValue(camp, f);
        if (deepEqual(fv, cv)) {
          merged[f] = cv;
        } else {
          merged[f] = cv; // 暂存编目台值
          conflicts.push({ field: f, campValue: cv, fieldValue: fv, baseValue: undefined });
        }
      });
      return { put: merged as unknown as EntityRecord, autoFields, conflicts, isNew: false };
    }
    if (field) return { put: field, autoFields: ENTITY_FIELDS[type], conflicts: [], isNew: true };
    return { autoFields: [], conflicts: [], isNew: false }; // 仅编目台新增或都不存在：不动
  }

  /* ---- 基线存在 ---- */
  if (field && camp) {
    const fields = ENTITY_FIELDS[type];
    const merged: Record<string, unknown> = { ...(camp as unknown as Record<string, unknown>) };
    const autoFields: string[] = [];
    const conflicts: FieldConflictSpec[] = [];

    fields.forEach((f) => {
      const bv = fieldValue(base, f);
      const fv = fieldValue(field, f);
      const cv = fieldValue(camp, f);
      const fieldChanged = !deepEqual(fv, bv);
      const campChanged = !deepEqual(cv, bv);

      if (fieldChanged && !campChanged) {
        merged[f] = fv; // 仅现场改过 → 自动接入
        autoFields.push(f);
      } else if (!fieldChanged && campChanged) {
        merged[f] = cv; // 仅编目台改过 → 保留
      } else if (fieldChanged && campChanged) {
        if (deepEqual(fv, cv)) {
          merged[f] = fv; // 两边改成相同值
          autoFields.push(f);
        } else {
          merged[f] = cv; // 两边都改且不同 → 暂存编目台值，留两份待处理
          conflicts.push({ field: f, campValue: cv, fieldValue: fv, baseValue: bv });
        }
      } else {
        merged[f] = bv;
      }
    });

    return { put: merged as unknown as EntityRecord, autoFields, conflicts, isNew: false };
  }

  if (field && !camp) {
    // 编目台一侧没有该记录（已删除）
    if (!recordChanged(type, field, base)) {
      return { deleted: true, autoFields: [], conflicts: [], isNew: false };
    }
    return {
      put: field, // 暂按现场版恢复，待人工决定（camp=删除）
      autoFields: [],
      conflicts: [{ field: RECORD_DELETED_FIELD, campValue: null, fieldValue: field, baseValue: base }],
      isNew: false,
    };
  }

  if (!field && camp) {
    // 现场一侧已删除
    if (!recordChanged(type, camp, base)) {
      return { deleted: true, autoFields: [], conflicts: [], isNew: false };
    }
    return {
      put: camp, // 暂保留编目台版，待人工决定（field=删除）
      autoFields: [],
      conflicts: [{ field: RECORD_DELETED_FIELD, campValue: camp, fieldValue: null, baseValue: base }],
      isNew: false,
    };
  }

  // 两边都删了
  return { deleted: true, autoFields: [], conflicts: [], isNew: false };
}
