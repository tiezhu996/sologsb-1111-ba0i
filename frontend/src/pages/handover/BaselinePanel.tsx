import { useEffect, useState } from 'react';
import { App as AntApp, Button, Form, Input, Modal, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import type { CatalogBaseline } from '../../types/handover';
import { createBaseline, listBaselines } from '../../utils/baseline';
import { downloadText } from '../../utils/export';

const { Text } = Typography;

const SOURCE_TEXT: Record<CatalogBaseline['source'], { text: string; color: string }> = {
  initial: { text: '升级回填', color: 'default' },
  manual: { text: '离场建版', color: 'blue' },
  merge: { text: '合并推进', color: 'green' },
};

/** 编目基线版本管理：与现场交接批次分开保存，离场前建版并让交接包自带基线 */
export default function BaselinePanel() {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<CatalogBaseline[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ label: string; createdBy: string }>();

  const refresh = async () => {
    setLoading(true);
    try {
      setRows(await listBaselines());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const submit = async () => {
    const values = await form.validateFields();
    await createBaseline({ label: values.label, createdBy: values.createdBy, source: 'manual' });
    message.success('已创建编目基线版本（整库快照）');
    setOpen(false);
    form.resetFields();
    void refresh();
  };

  const download = (baseline: CatalogBaseline) => {
    downloadText(`${baseline.id}.json`, JSON.stringify({ app: 'gbdrillcore-baseline', baseline }, null, 2));
  };

  const columns: TableColumnsType<CatalogBaseline> = [
    {
      title: '版本',
      width: 130,
      render: (_, row) => (
        <Text strong>
          v{row.version} · {row.id}
        </Text>
      ),
    },
    { title: '基线名称', dataIndex: 'label' },
    {
      title: '来源',
      width: 100,
      render: (_, row) => <Tag color={SOURCE_TEXT[row.source].color}>{SOURCE_TEXT[row.source].text}</Tag>,
    },
    { title: '创建人', dataIndex: 'createdBy', width: 90 },
    { title: '创建时间', width: 170, render: (_, row) => dayjs(row.createdAt).format('YYYY-MM-DD HH:mm') },
    {
      title: '快照行数',
      width: 220,
      render: (_, row) => (
        <Space size={4}>
          <Tag>孔 {row.snapshot.holes.length}</Tag>
          <Tag>回次 {row.snapshot.runs.length}</Tag>
          <Tag>箱 {row.snapshot.boxes.length}</Tag>
          <Tag>岩性 {row.snapshot.lithos.length}</Tag>
        </Space>
      ),
    },
    {
      title: '操作',
      width: 130,
      render: (_, row) => (
        <Button size="small" type="link" onClick={() => download(row)}>
          下载基线
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => setOpen(true)}>
          离场前建编目基线
        </Button>
        <Text type="secondary">基线是三向合并的共同祖先；老数据升级后已自动回填 v1</Text>
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 8, hideOnSinglePage: true }}
      />
      <Modal open={open} title="新建编目基线版本" onCancel={() => setOpen(false)} onOk={submit} okText="建版" cancelText="取消">
        <Form form={form} layout="vertical" initialValues={{ createdBy: '编目员' }}>
          <Form.Item name="label" label="基线名称" rules={[{ required: true, message: '请输入基线名称' }]}>
            <Input placeholder="如：2401 孔甲组 10-04 离场基线" maxLength={40} />
          </Form.Item>
          <Form.Item name="createdBy" label="建版人" rules={[{ required: true, message: '请输入建版人' }]}>
            <Input maxLength={16} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
