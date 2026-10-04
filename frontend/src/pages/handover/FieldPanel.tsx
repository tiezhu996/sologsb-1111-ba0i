import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import type { EntityKind, FieldSession } from '../../types/handover';
import type { CatalogRow } from '../../types/handover';
import { ENTITY_DEFS, ENTITY_KINDS, mergeableFields, rowLabelOf } from '../../utils/entityFields';
import { sameValue } from '../../utils/merge';
import { abandonFieldSession, getFieldSession, saveFieldSession, sealAndClear, startFieldSession } from '../../utils/handover';
import { downloadText } from '../../utils/export';
import { uid } from '../../utils/id';
import type { DrillHole } from '../../types/drill-hole';
import type { RunShift } from '../../types/drill-run';

const { Text } = Typography;

type WorkingRow = Record<string, unknown> & { id: string };

const ROW_PREFIX: Record<EntityKind, string> = { holes: 'hole', runs: 'run', boxes: 'box', lithos: 'litho' };

/** 无网现场：以最新基线开出交接批次，现场改钻孔/回次/岩芯箱/岩性，封包交回营地合并 */
export default function FieldPanel() {
  const { message } = AntApp.useApp();
  const [session, setSession] = useState<FieldSession | null>(null);
  const [entity, setEntity] = useState<EntityKind>('runs');
  const [editing, setEditing] = useState<{ kind: EntityKind; row: WorkingRow; isNew: boolean } | null>(null);

  const refresh = async () => setSession((await getFieldSession()) ?? null);
  useEffect(() => {
    void refresh();
  }, []);

  const start = async (values: { rigNo: string; shift: string; sealedBy: string; note: string }) => {
    const created = await startFieldSession(values);
    message.success(`已按基线 ${created.baselineId} 开出现场批次 ${created.handoverId}（包内自带基线）`);
    setSession(created);
  };

  const updateRow = async (kind: EntityKind, row: WorkingRow, isNew: boolean) => {
    if (!session) return;
    const working = { ...session.working, [kind]: session.working[kind].map((r) => (r.id === row.id ? (row as unknown as CatalogRow) : r)) };
    const next = { ...session, working };
    await saveFieldSession(next);
    setSession((await getFieldSession()) ?? null);
    message.success(isNew ? '已新增（封包后自动接入）' : '现场改动已暂存');
  };

  const addRow = async (kind: EntityKind) => {
    if (!session) return;
    const id = uid(ROW_PREFIX[kind]);
    const draft: WorkingRow = { id, holeId: session.working.holes[0]?.id ?? '' };
    if (kind === 'runs') {
      draft.shift = (session.shift as RunShift) ?? '甲班';
      const last = [...session.working.runs].sort((a, b) => b.toDepth - a.toDepth)[0];
      draft.holeId = last?.holeId ?? draft.holeId;
      draft.fromDepth = last?.toDepth ?? 0;
      draft.toDepth = Number(((last?.toDepth ?? 0) + 5).toFixed(2));
      draft.coreLength = 0;
      draft.footage = 0;
      draft.recovery = 0;
      draft.waterLevel = 0;
      draft.drilledAt = new Date().toISOString();
      draft.runNo = `field-${Math.random().toString(36).slice(2, 6)}`;
      draft.recorder = session.sealedBy;
    }
    if (kind === 'boxes') {
      draft.slots = 10;
      draft.slotLength = 2.5;
      draft.damagedSlots = [];
      draft.boxedAt = new Date().toISOString();
      draft.shelfPos = 'A 区 1 架';
      draft.operator = session.sealedBy;
      draft.boxNo = `XF-${Math.random().toString(36).slice(2, 6)}`;
    }
    if (kind === 'lithos') {
      draft.fromDepth = 0;
      draft.toDepth = 5;
      draft.lithology = '花岗闪长岩';
      draft.color = '';
      draft.alteration = '无';
      draft.mineralization = '无';
      draft.rqd = 0;
      draft.sampleNo = '';
      draft.logger = session.sealedBy;
    }
    if (kind === 'holes') {
      draft.holeNo = `ZK-F-${Math.random().toString(36).slice(2, 5)}`;
      draft.coordX = 0;
      draft.coordY = 0;
      draft.collarElevation = 0;
      draft.designDepth = 0;
      draft.finalDepth = 0;
      draft.startDate = new Date().toISOString();
      draft.rigNo = session.rigNo;
      draft.shift = session.shift;
      draft.surveyData = [];
    }
    const working: FieldSession['working'] = {
      ...session.working,
      [kind]: [...session.working[kind], draft as unknown as CatalogRow],
    };
    const next = { ...session, working };
    await saveFieldSession(next);
    setSession((await getFieldSession()) ?? null);
    setEditing({ kind, row: draft, isNew: true });
  };

  const removeRow = async (kind: EntityKind, id: string) => {
    if (!session) return;
    const working = { ...session.working, [kind]: session.working[kind].filter((r) => r.id !== id) };
    await saveFieldSession({ ...session, working });
    setSession((await getFieldSession()) ?? null);
    message.success('已从工作集移除');
  };

  const seal = async () => {
    if (!session) return;
    const pkg = await sealAndClear(session);
    const changedCount = ENTITY_KINDS.reduce((sum, k) => sum + pkg.changes[k].length, 0);
    downloadText(`handover-${pkg.handoverId}.json`, JSON.stringify(pkg, null, 2));
    message.success(`已封包（含 ${changedCount} 行现场改动，包内自带基线 ${pkg.baselineId}），回营后在「回营合并」导入`);
    await refresh();
  };

  const abandon = async () => {
    await abandonFieldSession();
    message.info('已放弃现场批次');
    await refresh();
  };

  if (!session) {
    return (
      <div>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="无网作业流程"
          description="离场前以最新编目基线开出一个现场交接批次（基线随包带走）；现场在本页改动钻孔、回次、岩芯箱、岩性；回营后封包下载，再到「回营合并」导入。"
        />
        <Card size="small">
          <Form layout="inline" style={{ rowGap: 8 }} onFinish={start}>
            <Form.Item name="rigNo" label="钻机号" rules={[{ required: true, message: '请选择钻机' }]}>
              <Select style={{ width: 120 }} options={(['XY-1', 'XY-2', 'XY-4', 'HGY-300'] as const).map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="shift" label="班组" rules={[{ required: true, message: '请选择班组' }]}>
              <Select style={{ width: 100 }} options={['甲班', '乙班', '丙班'].map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="sealedBy" label="现场负责人" rules={[{ required: true, message: '请输入负责人' }]}>
              <Input style={{ width: 120 }} maxLength={16} />
            </Form.Item>
            <Form.Item name="note" label="备注">
              <Input style={{ width: 240 }} maxLength={60} placeholder="作业点位 / 任务说明" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit">
                开出现场批次
              </Button>
            </Form.Item>
          </Form>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <Space wrap>
            <Text strong>现场批次 {session.handoverId}</Text>
            <Tag color="blue">{session.rigNo}</Tag>
            <Tag>{session.shift}</Tag>
            <Tag>{session.sealedBy}</Tag>
            <Text type="secondary">基于基线 {session.baselineId}（{session.baselineLabel}）</Text>
          </Space>
        }
        description={
          <Space wrap>
            <Button type="primary" onClick={seal}>
              封包并下载交接包
            </Button>
            <Popconfirm title="放弃后本场改动全部丢失，确认？" onConfirm={abandon}>
              <Button danger>放弃批次</Button>
            </Popconfirm>
            <Text type="secondary">改动暂存本机 IndexedDB，刷新不丢；同一批重复导入营地只产生一张回执</Text>
          </Space>
        }
      />

      <Tabs
        activeKey={entity}
        onChange={(k) => setEntity(k as EntityKind)}
        items={ENTITY_KINDS.map((kind) => ({
          key: kind,
          label: `${ENTITY_DEFS[kind].label}（${diffStats(session, kind).modified + diffStats(session, kind).added} 改动）`,
          children: (
            <FieldTable
              key={kind}
              session={session}
              kind={kind}
              holes={session.working.holes as DrillHole[]}
              onEdit={(row, isNew) => setEditing({ kind, row, isNew })}
              onAdd={() => addRow(kind)}
              onRemove={(id) => removeRow(kind, id)}
            />
          ),
        }))}
      />

      {editing ? (
        <RowEditor
          kind={editing.kind}
          initial={editing.row}
          holes={session.working.holes as DrillHole[]}
          onCancel={() => setEditing(null)}
          onSave={(row) => {
            void updateRow(editing.kind, row, editing.isNew).then(() => setEditing(null));
          }}
        />
      ) : null}
    </div>
  );
}

/** 统计工作集相对基线的新增/修改行数 */

function diffStats(session: FieldSession, kind: EntityKind): { modified: number; added: number } {
  const base = new Map<string, WorkingRow>(
    session.baseline[kind].map((r) => [r.id, r as unknown as WorkingRow]),
  );
  let modified = 0;
  let added = 0;
  session.working[kind].forEach((r) => {
    const b = base.get(r.id);
    if (!b) added += 1;
    else if (mergeableFields(kind).some((f) => !sameValue((r as unknown as WorkingRow)[f.key], b[f.key]))) modified += 1;
  });
  return { modified, added };
}

interface FieldTableProps {
  session: FieldSession;
  kind: EntityKind;
  holes: DrillHole[];
  onEdit: (row: WorkingRow, isNew: boolean) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}

function FieldTable({ session, kind, holes, onEdit, onAdd, onRemove }: FieldTableProps) {
  const base = useMemo(
    () => new Map<string, WorkingRow>(session.baseline[kind].map((r) => [r.id, r as unknown as WorkingRow])),
    [session, kind],
  );
  const holeNo = (id: unknown) => holes.find((h) => h.id === id)?.holeNo ?? String(id ?? '-');

  const columns: TableColumnsType<WorkingRow> = [
    {
      title: '名称',
      width: 150,
      render: (_, r) => <Text strong>{kind === 'lithos' ? `${r.fromDepth}~${r.toDepth}m` : String(r[ENTITY_DEFS[kind].labelField] ?? r.id)}</Text>,
    },
    { title: '钻孔', width: 110, render: (_, r) => holeNo(r.holeId) },
    {
      title: '深度区间(m)',
      width: 130,
      render: (_, r) => (kind === 'holes' ? '-' : `${r.fromDepth}~${r.toDepth}`),
    },
    {
      title: '状态',
      width: 110,
      render: (_, r) => {
        const b = base.get(r.id) as WorkingRow | undefined;
        if (!b) return <Tag color="green">现场新增</Tag>;
        const changed = mergeableFields(kind).some((f) => !sameValue(r[f.key], b[f.key]));
        return changed ? <Tag color="orange">已改</Tag> : <Tag>未改</Tag>;
      },
    },
    {
      title: '改动字段',
      render: (_, r) => {
        const b = base.get(r.id) as WorkingRow | undefined;
        if (!b) return <Text type="secondary">整行新增</Text>;
        const changed = mergeableFields(kind).filter((f) => !sameValue(r[f.key], b[f.key]));
        return changed.length ? changed.map((f) => <Tag key={f.key}>{f.label}</Tag>) : <Text type="secondary">—</Text>;
      },
    },
    {
      title: '操作',
      width: 150,
      fixed: 'right',
      render: (_, r) => {
        const isNew = !base.has(r.id);
        return (
          <Space size={2}>
            <Button size="small" type="link" onClick={() => onEdit(r, isNew)}>
              {isNew ? '完善' : '改字段'}
            </Button>
            {isNew ? (
              <Button size="small" type="link" danger onClick={() => onRemove(r.id)}>
                移除
              </Button>
            ) : null}
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Button size="small" type="primary" onClick={onAdd}>
          新增{ENTITY_DEFS[kind].label}
        </Button>
        <Text type="secondary">只改封包所需字段；回次改深度/岩芯长度后采取率自动重算</Text>
      </Space>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={session.working[kind] as unknown as WorkingRow[]}
        pagination={{ pageSize: 8, hideOnSinglePage: true }}
        scroll={{ x: 900 }}
      />
    </div>
  );
}

interface RowEditorProps {
  kind: EntityKind;
  initial: WorkingRow;
  holes: DrillHole[];
  onCancel: () => void;
  onSave: (row: WorkingRow) => void;
}

/** 行字段编辑：标量字段直接编辑，数组/复杂字段以 JSON 编辑；派生字段只读展示 */
function RowEditor({ kind, initial, holes, onCancel, onSave }: RowEditorProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const fields = ENTITY_DEFS[kind].fields;

  const initialValues = useMemo(() => {
    const values: Record<string, unknown> = {};
    fields.forEach((f) => {
      if (f.type === 'date') values[f.key] = initial[f.key] ? dayjs(initial[f.key] as string) : undefined;
      else if (f.type === 'array') values[f.key] = JSON.stringify(initial[f.key] ?? (f.key === 'damagedSlots' ? [] : []));
      else values[f.key] = initial[f.key] ?? undefined;
    });
    return values;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

  const submit = async () => {
    let values: Record<string, unknown>;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const next: WorkingRow = { ...initial };
    try {
      fields.forEach((f) => {
        if (f.derived) return;
        let value = values[f.key];
        if (f.type === 'date') value = value ? dayjs(value as dayjs.Dayjs).toISOString() : undefined;
        else if (f.type === 'array') {
          value = value ? JSON.parse(value as string) : f.key === 'damagedSlots' ? [] : [];
        } else if (f.type === 'number') value = Number(value) || 0;
        next[f.key] = value;
      });
    } catch (error) {
      message.error((error as Error).message);
      return;
    }
    onSave(next);
  };

  return (
    <Modal
      open
      width={680}
      title={`现场改 ${ENTITY_DEFS[kind].label} · ${rowLabelOf(kind, initial)}`}
      onCancel={onCancel}
      onOk={() => void submit()}
      okText="暂存改动"
      cancelText="取消"
    >
      <Form form={form} layout="vertical" initialValues={initialValues}>
        <Row gutter={12}>
          {fields.map((f) => {
            const disabled = f.derived;
            const node = (() => {
              if (f.key === 'holeId') {
                return <Select options={holes.map((h) => ({ label: `${h.holeNo}（${h.id}）`, value: h.id }))} />;
              }
              switch (f.type) {
                case 'number':
                  return <InputNumber style={{ width: '100%' }} disabled={disabled} />;
                case 'date':
                  return <DatePicker style={{ width: '100%' }} />;
                case 'enum':
                  return <Select options={(f.options ?? []).map((v) => ({ label: v, value: v }))} />;
                case 'array':
                  return <Input.TextArea rows={2} placeholder={f.key === 'damagedSlots' ? '[4,7]' : 'JSON 数组'} />;
                default:
                  return <Input maxLength={f.key === 'remark' ? 60 : 40} />;
              }
            })();
            return (
              <Col xs={24} sm={12} key={f.key}>
                <Form.Item
                  name={f.key}
                  label={f.derived ? `${f.label}（自动重算，只读）` : f.label}
                  rules={f.type === 'array' ? [] : [{ required: f.key !== 'remark' && f.key !== 'endDate' && f.key !== 'sampleNo' && f.key !== 'waterLevel' }]}
                >
                  {node}
                </Form.Item>
              </Col>
            );
          })}
        </Row>
      </Form>
    </Modal>
  );
}
