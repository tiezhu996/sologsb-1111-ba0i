# 矿区钻孔岩芯编目台（gbdrillcore）

面向地质勘查钻探班组与地质编录员：登记钻孔台帐、回次进尺与采取率、岩芯箱箱位，并按深度区间编录岩性描述与样品。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21811>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | Ant Design 5 + @ant-design/icons |
| 路由 | React Router 6（5 条业务路由 + 404） |
| 状态 | Zustand（holeStore / runStore / boxStore / lithoStore） |
| 存储 | IndexedDB（Dexie，库名 `gbdrillcore-db`，schema v3） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21811
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # drill-hole / drill-run / core-box / litho-log
│       ├── stores/            # holeStore / runStore / boxStore / lithoStore
│       ├── components/common/ # DepthRangeInput / RecoveryBadge / BoxGrid / LithoColumn / StatBadge / FilterBar / EmptyPanel
│       ├── hooks/             # useHoleFilter / useDepthCalc
│       ├── pages/             # HoleBoard / HoleList / RunLog / CoreBoxList / LithoEditor / Handover
│       ├── router/index.tsx   # 路由表
│       └── utils/             # recovery.ts / db.ts / export.ts / baseline.ts / handover.ts / merge.ts / entityFields.ts（+ seed.ts / id.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 工作台 | 钻孔进度、设计达成率、未达设计待补勘清单、采取率异常清单（<75% 标红） |
| `/holes` | 钻孔台帐 | 建孔、坐标与孔口标高、设计/终孔深度、测斜数据、回次深度覆盖与岩芯箱数回显 |
| `/runs` | 回次记录 | 起止深度自动算进尺与采取率，低于 75% 立即标红并入异常清单 |
| `/boxes` | 岩芯箱编目 | 格位网格按深度填充、破损格标记、装箱深度连续性与格位容量校验 |
| `/lithology` | 岩性编录 | 按深度区间编录岩性/蚀变/矿化/RQD/样品，区间重叠报冲突并高亮，SVG 岩性柱状图 |
| `/handover` | 断网交接 | 编目基线版本、无网现场批次、回营三向合并（替代会盖掉编目台内容的整库导入） |

## 断网现场交接合并

钻机班组在无网现场改动钻孔、回次、岩芯箱、岩性，回营后按 **基线 / 编目台现状 / 现场批次** 三向合并，不再使用会覆盖他人录入的整库恢复：

1. **编目基线（`baselines` 表）与现场批次（`handovers` 表）分开保存**。离场前在「断网交接 → 编目基线」建版，基线是整库只读快照（三向合并的共同祖先）；已有数据在 schema v3 升级时自动回填为 `baseline-0001`。
2. **包内自带基线**：在「无网现场」按最新基线开出现场批次（工作集存 `fieldSessions`，刷新不丢），现场改字段/新增行，封包下载的交接包 JSON 内含基线快照与改动行。
3. **回营三向合并**（「回营合并」导入交接包）：
   - 现场相对基线改过、编目台未动 → **自动接入**；编目台改过、现场未动 → 保留编目台；
   - **同一字段两边都改成不同值** → 不覆盖，写入 `conflicts` 表留两份值（基线/编目台/现场）待处理，可逐条或批量「采用现场 / 保留编目台」；
   - 现场新增行自动接入。
4. **一张回执**：批次回执按批次号唯一，重复导入同一批直接回原回执，不重复落数据。
5. **整批原子、失败可重试**：合并在单个 IndexedDB 事务内完成；任何一步写入失败整批回滚（业务数据不落库），批次回执保留为 `failed` 并带错误原因，可在界面上用留档原包**重试**。
6. **合并后推进新基线**：每次成功合并把当前整库存为新的编目基线版本（`source=merge`，关联批次号），供下一个现场批次使用。
7. **派生数据联动重算**：回次起止深度/岩芯长度接入后，进尺与采取率全量重算（派生字段不参与三向比对）；受影响孔的岩芯箱连续性随之重算，新出现的装箱断档写入回执并在界面告警。冲突处理改到回次行时同样触发重算。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbdrillcore-db`），表：`holes`、`runs`、`boxes`、`lithos`、`meta`、`baselines`、`handovers`、`conflicts`、`fieldSessions`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为岩性表增加 `[holeId+fromDepth]` 复合索引并回填历史 RQD；`db.version(3).upgrade(...)` 新增交接合并相关表，并把升级前的整库数据回填为首个编目基线版本 `baseline-0001`。升级前可用顶栏「导出备份」导出全量 JSON。
- 顶栏「导出备份/恢复备份」仍是全量整库操作，会清空并替换业务四表（迁移与应急用途）；日常断网交接请使用 `/handover` 的交接包合并，恢复备份不会改动 `handovers/conflicts` 等交接记录。
- 首次打开且表为空时写入一批示例编目数据（`src/utils/seed.ts`，5 个钻孔 + 回次 + 岩芯箱 + 岩性区间）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
