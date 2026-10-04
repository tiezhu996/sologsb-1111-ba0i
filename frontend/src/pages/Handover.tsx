import { Tabs, Typography } from 'antd';
import { CloudSyncOutlined, FileDoneOutlined, BranchesOutlined } from '@ant-design/icons';
import BaselinePanel from './handover/BaselinePanel';
import FieldPanel from './handover/FieldPanel';
import MergePanel from './handover/MergePanel';

const { Title, Paragraph } = Typography;

/** 断网现场交接：编目基线版本 / 无网现场批次 / 回营三向合并（批次与基线分开保存） */
export default function Handover() {
  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        断网现场交接
      </Title>
      <Paragraph type="secondary">
        钻机班组在无网现场改动钻孔、回次、岩芯箱、岩性，回营后按「编目基线 / 编目台现状 /
        现场批次」三向合并：一边改过自动接入，同一字段两边都改则留两份待处理。整批原子落库，失败可重试。
      </Paragraph>
      <Tabs
        defaultActiveKey="merge"
        items={[
          { key: 'baseline', label: <span><BranchesOutlined /> 编目基线</span>, children: <BaselinePanel /> },
          { key: 'field', label: <span><CloudSyncOutlined /> 无网现场</span>, children: <FieldPanel /> },
          { key: 'merge', label: <span><FileDoneOutlined /> 回营合并</span>, children: <MergePanel /> },
        ]}
      />
    </div>
  );
}
