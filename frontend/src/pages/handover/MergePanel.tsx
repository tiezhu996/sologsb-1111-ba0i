import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  Empty,
  Modal,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { TableColumnsType, UploadProps } from 'antd';
import { InboxOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { HandoverReceipt, MergeConflict } from '../../types/handover';
import type { EntityKind } from '../../types/handover';
import { fieldLabel, rowLabelOf, ENTITY_KINDS } from '../../utils/entityFields';
import { importHandover, listHandovers, listPendingConflicts, resolveConflict, resolveConflicts, retryHandover } from '../../utils/handover';
import { useHoleStore } from '../../stores/holeStore';
import { useRunStore } from '../../stores/runStore';
import { useBoxStore } from '../../stores/boxStore';
import { useLithoStore } from '../../stores/lithoStore';

const { Dragger } = Upload;
const { Text, Paragraph } = Typography;

/** 回营合并：导入现场交接包，三向合并；一边改过自动接入，两边都改留两份待处理 */
export default function MergePanel() {
  const { message } = AntApp.useApp();
  const [receipts, setReceipts] = useState<HandoverReceipt[]>([]);
  const [conflicts, setConflicts] = useState<MergeConflict[]>([]);
  const [importing, setImporting] = useState(false);
  const [activeReceiptId, setActiveReceiptId] = useState<string>('');
  const busyRef = useRef(false);

  const hydrateHoles = useHoleStore((s) => s.hydrate);
  const hydrateRuns = useRunStore((s) => s.hydrate);
  const hydrateBoxes = useBoxStore((s) => s.hydrate);
  const hydrateLithos = useLithoStore((s) => s.hydrate);
  const holes = useHoleStore((s) => s.holes);

  const holeNoOf = (id: string) => holes.find((h) => h.id === id)?.holeNo ?? id;

  const refresh = async () => {
    const [nextReceipts, nextConflicts] = await Promise.all([listHandovers(), listPendingConflicts()]);
    setReceipts(nextReceipts);
    setConflicts(nextConflicts);
    setActiveReceiptId((prev) => prev || nextReceipts.find((r) => r.status === 'failed')?.handoverId || '');
  };

  useEffect(() => {
    void refresh();
  }, []);

  const rehydrateAll = async () => {
    await Promise.all([hydrateHoles(), hydrateRuns(), hydrateBoxes(), hydrateLithos()]);
  };

  const mergeCount = receipts.filter((r) => r.status === 'merged').length;
  const failedCount = receipts.filter((r) => r.status === 'failed').length;

  const handleFile = async (file: File) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setImporting(true);
    try {
      const text = await file.text();
      const result = await importHandover(text);
      if (result.status === 'merged') {
        const o = result.outcome!;
        const applied = o.autoApplied.length;
        message.success(`批次已合并：自动接入 ${applied} 行，待处理冲突 ${o.conflictIds.length} 条，已推进到基线 ${o.baselineId}`);
        if (o.continuityWarnings.length) {
          message.warning(`${o.continuityWarnings.length} 个岩芯箱出现装箱断档，请核对岩芯箱页连续性`);
        }
      } else if (result.status === 'duplicate') {
        message.info('该批次此前已合并：重复导入只保留原回执，未重复落数据');
      } else {
        message.error(`批次写入失败，整批未落库，已留在待处理可重试：${result.receipt.error}`);
      }
      await rehydrateAll();
      await refresh();
    } catch (error) {
      message.error(`交接包无法识别：${(error as Error).message}`);
    } finally {
      busyRef.current = false;
      setImporting(false);
    }
    return false;
  };

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    multiple: false,
    showUploadList: false,
    beforeUpload: (file) => {
      void handleFile(file);
      return false;
    },
  };

  const retry = async (id: string) => {
    const result = await retryHandover(id);
    if (result.status === 'merged') {
      message.success(`重试成功：自动接入 ${result.outcome!.autoApplied.length} 行，冲突 ${result.outcome!.conflictIds.length} 条`);
      await rehydrateAll();
    } else {
      message.error(`仍失败（整批未落库）：${result.receipt.error}`);
    }
    await refresh();
  };

  const resolveOne = async (id: string, to: 'camp' | 'field') => {
    await resolveConflict(id, to);
    message.success(to === 'field' ? '已采用现场值' : '已保留编目台值');
    await Promise.all([refresh(), rehydrateAll()]);
  };

  const resolveBatch = async (to: 'camp' | 'field') => {
    if (!conflicts.length) return;
    Modal.confirm({
      title: `确认将 ${conflicts.length} 条待处理冲突全部${to === 'field' ? '采用现场值' : '保留编目台值'}？`,
      onOk: async () => {
        await resolveConflicts(conflicts.map((c) => c.id), to);
        message.success('已批量处理');
        await Promise.all([refresh(), rehydrateAll()]);
      },
    });
  };

  const outcomeOf = (r: HandoverReceipt) => r.result;

  const receiptColumns: TableColumnsType<HandoverReceipt> = [
    {
      title: '批次号',
      width: 180,
      render: (_, r) => (
        <Text strong copyable={{ text: r.handoverId }}>
          {r.handoverId}
        </Text>
      ),
    },
    { title: '钻机/班组', width: 110, render: (_, r) => `${r.rigNo} · ${r.shift}` },
    { title: '负责人', dataIndex: 'sealedBy', width: 90 },
    { title: '基线', dataIndex: 'baselineId', width: 130, render: (v: string) => <Tag>{v}</Tag> },
    { title: '封包时间', width: 160, render: (_, r) => dayjs(r.sealedAt).format('MM-DD HH:mm') },
    {
      title: '结果',
      width: 260,
      render: (_, r) => {
        if (r.status === 'failed') {
          return (
            <Space direction="vertical" size={2}>
              <Tag color="red">写入失败 · 整批未落库（第 {r.attempts} 次）</Tag>
              <Text type="danger" style={{ fontSize: 12 }}>
                {r.error}
              </Text>
            </Space>
          );
        }
        const o = outcomeOf(r);
        return (
          <Space size={4} wrap>
            <Tag color="green">已合并</Tag>
            <Tag color="blue">自动接入 {o?.autoApplied.length ?? 0}</Tag>
            <Tag color={o?.conflictIds.length ? 'orange' : 'default'}>冲突 {o?.conflictIds.length ?? 0}</Tag>
            <Tag color={o?.continuityWarnings.length ? 'red' : 'default'}>断档 {o?.continuityWarnings.length ?? 0}</Tag>
          </Space>
        );
      },
    },
    {
      title: '操作',
      width: 110,
      render: (_, r) =>
        r.status === 'failed' ? (
          <Button size="small" type="primary" icon={<ReloadOutlined />} onClick={() => retry(r.handoverId)}>
            重试
          </Button>
        ) : (
          <Button size="small" type="link" onClick={() => setActiveReceiptId(r.handoverId)}>
            查看回执
          </Button>
        ),
    },
  ];

  const conflictColumns: TableColumnsType<MergeConflict> = [
    { title: '表', dataIndex: 'entity', width: 70, render: (v: EntityKind) => <Tag>{entityLabel(v)}</Tag> },
    {
      title: '行',
      width: 180,
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <Text strong>{c.rowLabel}</Text>
          {c.holeId ? <Text type="secondary" style={{ fontSize: 12 }}>{holeNoOf(c.holeId)}</Text> : null}
        </Space>
      ),
    },
    { title: '字段', width: 120, render: (_, c) => fieldLabel(c.entity, c.field) },
    {
      title: '基线值',
      width: 150,
      render: (_, c) => <Text type="secondary">{formatValue(c.baseValue)}</Text>,
    },
    { title: '编目台值', width: 150, render: (_, c) => <Text type="success">{formatValue(c.campValue)}</Text> },
    { title: '现场值', width: 150, render: (_, c) => <Text style={{ color: '#d48806' }}>{formatValue(c.fieldValue)}</Text> },
    {
      title: '处理',
      width: 200,
      fixed: 'right',
      render: (_, c) => (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => resolveOne(c.id, 'field')}>
            采用现场
          </Button>
          <Button size="small" type="link" onClick={() => resolveOne(c.id, 'camp')}>
            保留编目台
          </Button>
        </Space>
      ),
    },
  ];

  const activeReceipt = receipts.find((r) => r.handoverId === activeReceiptId);

  return (
    <div>
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col xs={8} md={6}>
          <Card size="small"><Statistic title="已合并批次" value={mergeCount} /></Card>
        </Col>
        <Col xs={8} md={6}>
          <Card size="small"><Statistic title="写入失败待重试" value={failedCount} valueStyle={{ color: failedCount ? '#cf1322' : undefined }} /></Card>
        </Col>
        <Col xs={8} md={6}>
          <Card size="small"><Statistic title="字段冲突待处理" value={conflicts.length} valueStyle={{ color: conflicts.length ? '#d48806' : undefined }} /></Card>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col xs={24} lg={9}>
          <Card size="small" title="导入现场交接包" style={{ marginBottom: 12 }}>
            <Dragger {...uploadProps} disabled={importing} style={{ padding: '12px 8px' }}>
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">{importing ? '正在整批合并…' : '点击或拖入交接包 JSON'}</p>
              <p className="ant-upload-hint">包内自带编目基线，按 基线 / 编目台 / 现场 三向合并</p>
            </Dragger>
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
              同一批重复导入只产生一张回执；写入失败整批不落库、留在待处理可重试。
            </Paragraph>
          </Card>

          {activeReceipt?.status === 'merged' ? <ReceiptDetail receipt={activeReceipt} holeNoOf={holeNoOf} /> : null}
        </Col>

        <Col xs={24} lg={15}>
          <Card
            size="small"
            style={{ marginBottom: 12 }}
            title={
              <Space>
                现场交接批次回执
                <Badge count={failedCount} showZero={false} color="#cf1322" />
              </Space>
            }
          >
            <Table
              rowKey="handoverId"
              size="small"
              columns={receiptColumns}
              dataSource={receipts}
              pagination={{ pageSize: 5, hideOnSinglePage: true }}
              scroll={{ x: 1000 }}
              locale={{ emptyText: <Empty description="暂无导入批次" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            />
          </Card>

          <Card
            size="small"
            title={
              <Space>
                <Badge color={conflicts.length ? '#faad14' : '#52c41a'} />
                字段冲突待处理（同一字段两边都改过 → 两份留档）
              </Space>
            }
            extra={
              conflicts.length ? (
                <Space>
                  <Button size="small" onClick={() => resolveBatch('field')}>
                    全部采用现场
                  </Button>
                  <Button size="small" onClick={() => resolveBatch('camp')}>
                    全部保留编目台
                  </Button>
                </Space>
              ) : undefined
            }
          >
            {conflicts.length ? (
              <Alert
                style={{ marginBottom: 10 }}
                type="warning"
                showIcon
                message={`共 ${conflicts.length} 条：合并时已暂留编目台值，选定后即时落库；改到回次行会连带重算采取率`}
              />
            ) : null}
            <Table
              rowKey="id"
              size="small"
              columns={conflictColumns}
              dataSource={conflicts}
              pagination={{ pageSize: 6, hideOnSinglePage: true }}
              scroll={{ x: 1100 }}
              locale={{ emptyText: <Empty description="没有待处理冲突，两边改过的字段都已接入或处理完" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}

function ReceiptDetail({ receipt, holeNoOf }: { receipt: HandoverReceipt; holeNoOf: (id: string) => string }) {
  const o = receipt.result;
  const groups = useMemo(() => {
    const map = new Map<EntityKind, { added: number; updated: number }>();
    ENTITY_KINDS.forEach((k) => map.set(k, { added: 0, updated: 0 }));
    o?.autoApplied.forEach((a) => {
      const g = map.get(a.entity)!;
      if (a.action === 'added') g.added += 1;
      else g.updated += 1;
    });
    return map;
  }, [o]);

  return (
    <Card size="small" title={`回执 · ${receipt.handoverId}`}>
      <Collapse
        size="small"
        items={[
          {
            key: 'detail',
            label: '合并明细',
            children: o ? (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space wrap>
                  {[...groups.entries()].map(([kind, g]) => (
                    <Tag key={kind}>
                      {entityLabel(kind)}：新增 {g.added} / 改 {g.updated}
                    </Tag>
                  ))}
                </Space>
                <Text type="secondary">回次重算孔：{o.recomputedHoleIds.length ? o.recomputedHoleIds.map(holeNoOf).join('、') : '—'}</Text>
                <Text type="secondary">推进基线：{o.baselineId}（v{o.baselineVersion}）· {dayjs(o.mergedAt).format('YYYY-MM-DD HH:mm')}</Text>
                {o.continuityWarnings.length ? (
                  <Alert
                    type="error"
                    showIcon
                    message="回次变化带动岩芯箱连续性重算，出现断档："
                    description={o.continuityWarnings.map((w) => (
                      <div key={w.boxId}>
                        <Tag color="red">{w.boxNo}</Tag>
                        <Text type="secondary">{holeNoOf(w.holesId)} · {w.message}</Text>
                      </div>
                    ))}
                  />
                ) : (
                  <Text type="success">受影响岩芯箱深度区间均被回次连续覆盖</Text>
                )}
              </Space>
            ) : (
              <Text type="secondary">无合并结果</Text>
            ),
          },
        ]}
      />
    </Card>
  );
}

function entityLabel(kind: EntityKind): string {
  return { holes: '钻孔', runs: '回次', boxes: '岩芯箱', lithos: '岩性' }[kind];
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '（空）';
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
