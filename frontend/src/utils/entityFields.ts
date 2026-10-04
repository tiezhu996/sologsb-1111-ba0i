import type { EntityKind } from '../types/handover';

/** 可交接字段元数据：现场编辑、冲突展示、三向合并共用同一份字段清单 */
export interface FieldDef {
  key: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'array' | 'enum';
  options?: string[];
  /** 派生字段（由其他字段自动重算），不参与三向比对与现场编辑 */
  derived?: boolean;
}

export interface EntityDef {
  kind: EntityKind;
  label: string;
  rowLabel: string;
  /** 业务主键字段（生成行展示名时优先使用） */
  labelField: string;
  /** 三向合并逐字段比对的字段（不含 id 与派生字段） */
  fields: FieldDef[];
}

export const ENTITY_DEFS: Record<EntityKind, EntityDef> = {
  holes: {
    kind: 'holes',
    label: '钻孔',
    rowLabel: '钻孔',
    labelField: 'holeNo',
    fields: [
      { key: 'holeNo', label: '孔号', type: 'string' },
      { key: 'coordX', label: '坐标 X', type: 'number' },
      { key: 'coordY', label: '坐标 Y', type: 'number' },
      { key: 'collarElevation', label: '孔口标高(m)', type: 'number' },
      { key: 'designDepth', label: '设计孔深(m)', type: 'number' },
      { key: 'finalDepth', label: '终孔深度(m)', type: 'number' },
      { key: 'startDate', label: '开孔日期', type: 'date' },
      { key: 'endDate', label: '终孔日期', type: 'date' },
      { key: 'rigNo', label: '钻机号', type: 'enum', options: ['XY-1', 'XY-2', 'XY-4', 'HGY-300'] },
      { key: 'shift', label: '施工班组', type: 'enum', options: ['甲班', '乙班', '丙班'] },
      { key: 'surveyData', label: '测斜数据', type: 'array' },
      { key: 'remark', label: '备注', type: 'string' },
    ],
  },
  runs: {
    kind: 'runs',
    label: '回次',
    rowLabel: '回次',
    labelField: 'runNo',
    fields: [
      { key: 'runNo', label: '回次号', type: 'string' },
      { key: 'holeId', label: '所属钻孔', type: 'string' },
      { key: 'fromDepth', label: '起深度(m)', type: 'number' },
      { key: 'toDepth', label: '止深度(m)', type: 'number' },
      { key: 'footage', label: '进尺(m)', type: 'number', derived: true },
      { key: 'coreLength', label: '岩芯长度(m)', type: 'number' },
      { key: 'recovery', label: '采取率(%)', type: 'number', derived: true },
      { key: 'waterLevel', label: '回次水位(m)', type: 'number' },
      { key: 'shift', label: '班次', type: 'enum', options: ['甲班', '乙班', '丙班'] },
      { key: 'drilledAt', label: '钻进日期', type: 'date' },
      { key: 'recorder', label: '记录人', type: 'string' },
      { key: 'remark', label: '备注', type: 'string' },
    ],
  },
  boxes: {
    kind: 'boxes',
    label: '岩芯箱',
    rowLabel: '岩芯箱',
    labelField: 'boxNo',
    fields: [
      { key: 'boxNo', label: '箱号', type: 'string' },
      { key: 'holeId', label: '所属钻孔', type: 'string' },
      { key: 'fromDepth', label: '起始深度(m)', type: 'number' },
      { key: 'toDepth', label: '终止深度(m)', type: 'number' },
      { key: 'slots', label: '格数', type: 'number' },
      { key: 'slotLength', label: '每格长度(m)', type: 'number' },
      { key: 'boxedAt', label: '装箱日期', type: 'date' },
      { key: 'shelfPos', label: '库架位', type: 'string' },
      { key: 'damagedSlots', label: '破损格', type: 'array' },
      { key: 'operator', label: '装箱人', type: 'string' },
      { key: 'remark', label: '备注', type: 'string' },
    ],
  },
  lithos: {
    kind: 'lithos',
    label: '岩性',
    rowLabel: '岩性区间',
    labelField: '',
    fields: [
      { key: 'holeId', label: '所属钻孔', type: 'string' },
      { key: 'fromDepth', label: '起始深度(m)', type: 'number' },
      { key: 'toDepth', label: '终止深度(m)', type: 'number' },
      { key: 'lithology', label: '岩性', type: 'enum', options: ['花岗闪长岩', '大理岩', '矽卡岩', '断层角砾岩', '第四系覆盖层'] },
      { key: 'color', label: '颜色', type: 'string' },
      { key: 'alteration', label: '蚀变', type: 'enum', options: ['无', '硅化', '绿泥石化', '碳酸盐化', '矽卡岩化'] },
      { key: 'mineralization', label: '矿化', type: 'enum', options: ['无', '黄铜矿', '磁铁矿', '黄铁矿', '方铅矿'] },
      { key: 'rqd', label: 'RQD(%)', type: 'number' },
      { key: 'sampleNo', label: '样品号', type: 'string' },
      { key: 'logger', label: '编录人', type: 'string' },
      { key: 'remark', label: '备注', type: 'string' },
    ],
  },
};

export const ENTITY_KINDS: EntityKind[] = ['holes', 'runs', 'boxes', 'lithos'];

/** 参与三向比对的业务字段（排除派生字段） */
export function mergeableFields(kind: EntityKind): FieldDef[] {
  return ENTITY_DEFS[kind].fields.filter((f) => !f.derived);
}

export function fieldLabel(kind: EntityKind, field: string): string {
  return ENTITY_DEFS[kind].fields.find((f) => f.key === field)?.label ?? field;
}

/** 岩性行无业务主键，用深度区间做展示名 */
export function rowLabelOf(kind: EntityKind, row: Record<string, unknown>): string {
  if (kind === 'lithos') return `${row.holeId} ${row.fromDepth}~${row.toDepth}m`;
  return String(row[ENTITY_DEFS[kind].labelField] ?? row.id ?? '未命名');
}
