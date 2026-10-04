import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CloudUploadOutlined,
  FileSyncOutlined,
  ReloadOutlined,
  SaveOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { RIG_NOS, SHIFTS } from '../types/drill-hole';
import type {
  CatalogBaseline,
  FieldConflict,
  HandoverBatch,
  HandoverPackage,
  MergeReceipt,
} from '../types/sync';
import { ENTITY_LABEL, ENTITY_TYPES } from '../types/sync';
import { FIELD_LABEL } from '../utils/syncFields';
import { downloadText } from '../utils/export';
import {
  buildHandoverPackage,
  createBaseline,
  importHandoverPackage,
  listAllConflicts,
  listBatches,
  listBaselines,
  resolveConflict,
  retryBatch,
} from '../utils/sync';
import { useHoleStore } from '../stores/holeStore';
import { useRunStore } from '../stores/runStore';
import { useBoxStore } from '../stores/boxStore';
import { useLithoStore } from '../stores/lithoStore';

const { Title, Paragraph, Text } = Typography;

const STATUS_META: Record<HandoverBatch['status'], { color: string; text: string }> = {
  pending: { color: 'default', text: '待处理' },
  failed: { color: 'red', text: '写入失败·可重试' },
  conflicted: { color: 'orange', text: '有字段冲突' },
  merged: { color: 'green', text: '已合并' },
};

/** 将字段值渲染为简短文案（id 映射孔号、结构化值 JSON 折叠） */
function ValueView({ value, holeNameOf }: { value: unknown; holeNameOf: (id: string) => string }) {
  if (value == null || value === '') return <Text type="secondary">空</Text>;
  if (typeof value === 'object') {
    if (Array.isArray(value) && value.length && typeof value[0] === 'object') {
      return <Text code>{JSON.stringify(value)}</Text>;
    }
    return <Text code>{JSON.stringify(value)}</Text>;
  }
  if (typeof value === 'string' && value.startsWith('hole-')) {
    return <Tag>{holeNameOf(value)}</Tag>;
  }
  return <Text>{String(value)}</Text>;
}

export default function SyncCenter() {
  const { message, modal } = AntApp.useApp();
  const hydrateHoles = useHoleStore((s) => s.hydrate);
  const hydrateRuns = useRunStore((s) => s.hydrate);
  const hydrateBoxes = useBoxStore((s) => s.hydrate);
  const hydrateLithos = useLithoStore((s) => s.hydrate);
  const holes = useHoleStore((s) => s.holes);

  const [baselines, setBaselines] = useState<CatalogBaseline[]>([]);
  const [batches, setBatches] = useState<HandoverBatch[]>([]);
  const [conflicts, setConflicts] = useState<FieldConflict[]>([]);
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [packOpen, setPackOpen] = useState(false);
  const [receiptBatch, setReceiptBatch] = useState<HandoverBatch | null>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [baselineForm] = Form.useForm<{ note: string }>();
  const [packForm] = Form.useForm<{ rigNo: string; shift: string; note?: string }>();

  const refresh = useCallback(async () => {
    const [bs, bts, cfs] = await Promise.all([listBaselines(), listBatches(), listAllConflicts()]);
    setBaselines(bs);
    setBatches(bts);
    setConflicts(cfs);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const hydrateBusiness = useCallback(async () => {
    await Promise.all([hydrateHoles(), hydrateRuns(), hydrateBoxes(), hydrateLithos()]);
  }, [hydrateHoles, hydrateRuns, hydrateBoxes, hydrateLithos]);

  const holeNameOf = useCallback(
    (id: string) => holes.find((h) => h.id === id)?.holeNo ?? id,
    [holes],
  );

  const pendingConflicts = useMemo(() => conflicts.filter((c) => c.status === 'pending'), [conflicts]);
  const failedBatches = useMemo(() => batches.filter((b) => b.status === 'failed' || b.status === 'pending'), [batches]);

  const showReceipt = (receipt: MergeReceipt, reused: boolean) => {
    modal.info({
      title: reused ? '该批次已导入过（沿用原回执）' : '现场交接批次合并完成',
      width: 720,
      content: <ReceiptView receipt={receipt} />,
      okText: '知道了',
    });
  };

  /* ---------------- 基线 ---------------- */

  const submitBaseline = async () => {
    const values = await baselineForm.validateFields();
    const baseline = await createBaseline(values.note || '出工前编目基线');
    message.success(`已建立编目基线版本 ${baseline.id}`);
    setBaselineOpen(false);
    baselineForm.resetFields();
    refresh();
  };

  /* ---------------- 现场封包 ---------------- */

  const submitPack = async () => {
    const values = await packForm.validateFields();
    setLoading(true);
    try {
      const pkg: HandoverPackage = await buildHandoverPackage(values);
      downloadText(
        `handover-${pkg.rigNo}-${dayjs(pkg.packedAt).format('YYYYMMDD-HHmmss')}.json`,
        JSON.stringify(pkg, null, 2),
      );
      message.success('现场交接包已生成（自带编目基线，回营地后在本页导入）');
      setPackOpen(false);
      packForm.resetFields();
      refresh();
    } catch (error) {
      message.error(`封包失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  /* ---------------- 导入 / 重试 ---------------- */

  const handleFile = async (file: File) => {
    setLoading(true);
    try {
      const text = await file.text();
      const outcome = await importHandoverPackage(text);
      await hydrateBusiness();
      await refresh();
      if (outcome.receipt) showReceipt(outcome.receipt, outcome.reused);
      if (outcome.batch.status === 'failed') {
        message.error(`批次 ${outcome.batch.id} 写入失败，整批未落库，已留在待处理可重试`);
      } else if (outcome.batch.status === 'conflicted') {
        message.warning(`批次已合并非冲突内容，${outcome.batch.pendingConflictCount} 个字段两边都改过，待处理`);
      } else if (!outcome.reused) {
        message.success('批次合并完成');
      }
    } catch (error) {
      await refresh();
      const batch = (error as { batch?: HandoverBatch }).batch;
      if (batch) {
        message.error(`写入失败（整批未落库）：${batch.lastError}。批次已留在待处理，可重试`);
      } else {
        message.error(`导入失败：${(error as Error).message}`);
      }
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleRetry = async (batchId: string) => {
    setLoading(true);
    try {
      const outcome = await retryBatch(batchId);
      await hydrateBusiness();
      await refresh();
      if (outcome.receipt) showReceipt(outcome.receipt, false);
      if (outcome.batch.status === 'conflicted') {
        message.warning(`重试成功，仍有 ${outcome.batch.pendingConflictCount} 个字段冲突待处理`);
      } else {
        message.success('批次重试合并完成');
      }
    } catch (error) {
      await refresh();
      const batch = (error as { batch?: HandoverBatch }).batch;
      message.error(`重试仍失败（整批未落库）：${batch?.lastError ?? (error as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  /* ---------------- 冲突处理 ---------------- */

  const handleResolve = async (conflict: FieldConflict, resolution: 'camp' | 'field') => {
    setLoading(true);
    try {
      await resolveConflict(conflict.id, resolution);
      await hydrateBusiness();
      await refresh();
      message.success(resolution === 'field' ? '已采用现场值' : '已采用编目台值');
    } catch (error) {
      message.error(`处理失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const baselineColumns: TableColumnsType<CatalogBaseline> = [
    { title: '基线编号', dataIndex: 'id', width: 200, render: (v: string) => <Text code>{v}</Text> },
    { title: '建立时间', width: 170, render: (_, r) => dayjs(r.createdAt).format('YYYY-MM-DD HH:mm') },
    {
      title: '快照记录数',
      width: 260,
      render: (_, r) => (
        <Space size={4} wrap>
          {ENTITY_TYPES.map((t) => (
            <Tag key={t}>
              {ENTITY_LABEL[t]} {r.snapshot[t].length}
            </Tag>
          ))}
        </Space>
      ),
    },
    { title: '说明', dataIndex: 'note' },
  ];

  const batchColumns: TableColumnsType<HandoverBatch> = [
    { title: '批次编号', dataIndex: 'id', width: 190, render: (v: string) => <Text code>{v}</Text> },
    { title: '钻机/班组', width: 120, render: (_, r) => `${r.rigNo} · ${r.shift}` },
    { title: '封包时间', width: 150, render: (_, r) => dayjs(r.packedAt).format('YYYY-MM-DD HH:mm') },
    { title: '自带基线', dataIndex: 'baselineId', width: 170, render: (v: string) => <Text code>{v}</Text> },
    {
      title: '状态',
      width: 130,
      render: (_, r) => (
        <Badge
          status={r.status === 'merged' ? 'success' : r.status === 'conflicted' ? 'warning' : 'error'}
          text={<Tag color={STATUS_META[r.status].color}>{STATUS_META[r.status].text}</Tag>}
        />
      ),
    },
    {
      title: '待处理冲突',
      width: 100,
      align: 'right',
      render: (_, r) => (r.pendingConflictCount ? <Tag color="orange">{r.pendingConflictCount}</Tag> : <Tag>0</Tag>),
    },
    {
      title: '操作',
      width: 220,
      render: (_, r) => (
        <Space size={2}>
          {r.receipt ? (
            <Button size="small" type="link" onClick={() => setReceiptBatch(r)}>
              查看回执
            </Button>
          ) : null}
          {r.status === 'failed' || r.status === 'pending' ? (
            <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => handleRetry(r.id)}>
              重试整批
            </Button>
          ) : null}
          {r.lastError ? (
            <Text type="danger" style={{ fontSize: 12 }}>
              {r.lastError}
            </Text>
          ) : null}
        </Space>
      ),
    },
  ];

  const conflictColumns: TableColumnsType<FieldConflict> = [
    { title: '批次', dataIndex: 'batchId', width: 170, render: (v: string) => <Text code>{v}</Text> },
    { title: '类目', width: 90, render: (_, r) => <Tag>{ENTITY_LABEL[r.entityType]}</Tag> },
    {
      title: '记录',
      width: 130,
      render: (_, r) =>
        r.entityType === 'holes' ? (
          <Text>{holeNameOf(r.entityId)}</Text>
        ) : (
          <Text code>{r.entityId.slice(0, 18)}</Text>
        ),
    },
    { title: '字段', width: 110, render: (_, r) => FIELD_LABEL[r.entityType][r.field] ?? r.field },
    {
      title: '编目台值',
      width: 200,
      render: (_, r) => (
        <div>
          <Tag color="blue">编目台</Tag>
          <ValueView value={r.campValue} holeNameOf={holeNameOf} />
        </div>
      ),
    },
    {
      title: '现场值',
      width: 200,
      render: (_, r) => (
        <div>
          <Tag color="geekblue">现场</Tag>
          <ValueView value={r.fieldValue} holeNameOf={holeNameOf} />
        </div>
      ),
    },
    {
      title: '处理',
      width: 200,
      render: (_, r) => (
        <Space direction="vertical" size={2}>
          <Button size="small" onClick={() => handleResolve(r, 'camp')}>
            采用编目台值
          </Button>
          <Button size="small" type="primary" ghost onClick={() => handleResolve(r, 'field')}>
            采用现场值
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        断网现场交接合并
      </Title>
      <Paragraph type="secondary">
        钻机班组无网现场改动钻孔、回次、岩芯箱与岩性，回营地后导入现场交接包：包内自带出工前的编目基线版本，与编目台新录内容做三方合并——只有一方改过的字段自动接入，同一字段两边都改过则留两份待人工处理。
      </Paragraph>

      {failedBatches.length > 0 ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="error"
          showIcon
          icon={<WarningOutlined />}
          message={`有 ${failedBatches.length} 个现场交接批次写入失败，整批未落库`}
          description="批次已留在待处理列表，修正后点击「重试整批」即可；重试是整批重放，不会产生半批数据。"
        />
      ) : null}
      {pendingConflicts.length > 0 ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message={`有 ${pendingConflicts.length} 个字段两边都改过，等待处理`}
          description="其余字段已自动接入并完成回次采取率、岩芯箱连续性重算；请逐条选择采用编目台值或现场值。"
        />
      ) : null}

      <Space style={{ marginBottom: 16 }} wrap>
        <Button type="primary" icon={<SaveOutlined />} onClick={() => setBaselineOpen(true)}>
          建立编目基线
        </Button>
        <Button icon={<FileSyncOutlined />} onClick={() => setPackOpen(true)}>
          现场交接封包
        </Button>
        <Button icon={<CloudUploadOutlined />} loading={loading} onClick={() => fileRef.current?.click()}>
          导入现场交接批次
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
        <Button icon={<ReloadOutlined />} onClick={refresh}>
          刷新
        </Button>
      </Space>

      <Row gutter={[16, 16]}>
        <Col xs={24}>
          <Card
            size="small"
            title={
              <Space>
                字段冲突待处理
                <Tag color={pendingConflicts.length ? 'orange' : 'green'}>{pendingConflicts.length} 条待处理</Tag>
              </Space>
            }
          >
            <Table
              rowKey="id"
              size="small"
              columns={conflictColumns}
              dataSource={pendingConflicts}
              pagination={{ pageSize: 5 }}
              scroll={{ x: 1200 }}
              locale={{ emptyText: <Empty description="没有待处理冲突" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            />
          </Card>
        </Col>

        <Col xs={24}>
          <Card size="small" title="现场交接批次与回执">
            <Table
              rowKey="id"
              size="small"
              columns={batchColumns}
              dataSource={batches}
              pagination={{ pageSize: 6 }}
              scroll={{ x: 1100 }}
              locale={{ emptyText: <Empty description="尚未导入任何现场交接批次" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            />
          </Card>
        </Col>

        <Col xs={24}>
          <Card size="small" title="编目基线版本（与交接批次分开保存）">
            <Table
              rowKey="id"
              size="small"
              columns={baselineColumns}
              dataSource={baselines}
              pagination={{ pageSize: 5 }}
              locale={{ emptyText: <Empty description="尚未建立编目基线" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            />
          </Card>
        </Col>
      </Row>

      {/* 建立基线 */}
      <Modal
        open={baselineOpen}
        title="建立编目基线版本"
        onCancel={() => setBaselineOpen(false)}
        onOk={submitBaseline}
        confirmLoading={loading}
        okText="建立"
        cancelText="取消"
      >
        <Paragraph type="secondary">
          对当前钻孔、回次、岩芯箱、岩性四类台账打快照，作为班组离网期间的共同祖先。升级 v3 时已自动把历史数据回填为一份基线。
        </Paragraph>
        <Form form={baselineForm} layout="vertical">
          <Form.Item name="note" label="基线说明" rules={[{ required: true, message: '请填写基线说明' }]}>
            <Input maxLength={60} placeholder="如：甲班 ZK-2401 出工前基线" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 现场封包 */}
      <Modal
        open={packOpen}
        title="现场交接封包"
        onCancel={() => setPackOpen(false)}
        onOk={submitPack}
        confirmLoading={loading}
        okText="生成交接包"
        cancelText="取消"
      >
        <Paragraph type="secondary">
          封包会带上最新编目基线与现场当前的全量记录（含删除清单）。无网环境带回营地后导入即可三方合并。
        </Paragraph>
        <Form form={packForm} layout="vertical" initialValues={{ rigNo: RIG_NOS[0], shift: SHIFTS[0] }}>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="rigNo" label="钻机号" rules={[{ required: true }]}>
              <Select style={{ width: 160 }} options={RIG_NOS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="shift" label="班组" rules={[{ required: true }]}>
              <Select style={{ width: 120 }} options={SHIFTS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="无最新基线时自动建基线的说明（可选）">
            <Input maxLength={60} placeholder="留空则使用「首次出工，按当前编目台建立基线」" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 回执抽屉 */}
      <Drawer open={!!receiptBatch} title="合并回执" width={640} onClose={() => setReceiptBatch(null)}>
        {receiptBatch?.receipt ? <ReceiptView receipt={receiptBatch.receipt} /> : <Empty />}
      </Drawer>
    </div>
  );
}

function ReceiptView({ receipt }: { receipt: MergeReceipt }) {
  const brokenBoxes = receipt.boxContinuity.filter((b) => !b.covered);
  return (
    <div>
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label="回执编号">
          <Text code>{receipt.id}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="批次编号">
          <Text code>{receipt.batchId}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="现场">
          {receipt.rigNo} · {receipt.shift}
        </Descriptions.Item>
        <Descriptions.Item label="自带基线">
          <Text code>{receipt.baselineId}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="封包时间">{dayjs(receipt.packedAt).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
        <Descriptions.Item label="合并时间">{dayjs(receipt.mergedAt).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
        <Descriptions.Item label="自动接入字段数">
          <Text strong>{receipt.autoFieldCount}</Text>
        </Descriptions.Item>
      </Descriptions>

      <Table
        style={{ marginTop: 12 }}
        size="small"
        pagination={false}
        rowKey="name"
        dataSource={ENTITY_TYPES.map((t) => ({
          name: ENTITY_LABEL[t],
          added: receipt.added[t],
          updated: receipt.updated[t],
          deleted: receipt.deleted[t],
          conflicts: receipt.conflicts[t],
        }))}
        columns={[
          { title: '类目', dataIndex: 'name', width: 100 },
          { title: '新增', dataIndex: 'added', align: 'right' },
          { title: '自动接入记录', dataIndex: 'updated', align: 'right' },
          { title: '按现场删除', dataIndex: 'deleted', align: 'right' },
          {
            title: '遗留冲突',
            dataIndex: 'conflicts',
            align: 'right',
            render: (v: number) => (v ? <Tag color="orange">{v}</Tag> : 0),
          },
        ]}
      />

      <Title level={5} style={{ marginTop: 16 }}>
        合并后岩芯箱连续性重算
      </Title>
      {receipt.boxContinuity.length === 0 ? (
        <Text type="secondary">本次合并未影响岩芯箱连续性。</Text>
      ) : (
        <Timeline
          items={receipt.boxContinuity.map((b) => ({
            color: b.covered ? 'green' : 'red',
            children: (
              <Space direction="vertical" size={0}>
                <Text strong>{b.boxNo}</Text>
                <Text type={b.covered ? 'success' : 'danger'} style={{ fontSize: 12 }}>
                  {b.message}
                </Text>
              </Space>
            ),
          }))}
        />
      )}
      {brokenBoxes.length > 0 ? (
        <Alert
          style={{ marginTop: 8 }}
          type="warning"
          showIcon
          message={`${brokenBoxes.length} 个岩芯箱在回次变化后出现装箱断档，请核查`}
        />
      ) : null}
    </div>
  );
}
