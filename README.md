# vibly-coordinator

vibly-coordinator 是 Vibly / Concord 协调网络的服务端节点。基于 Fastify + SQLite，封装 `@concord/sdk` 提供的协议内核，对外暴露 REST API，并可选地通过 **GovernanceIndexConsumer** 持续索引链上 OpenGov 状态。

## 依赖关系

```
vibly-client / vibly-console
       │  HTTP (REST + SSE)
       ▼
vibly-coordinator          ← 本仓库
  Fastify + SQLite
  @concord/sdk (协议内核)
  @concord/adapter-substrate-indexer (SubQuery 链上读模型)
       │  ws://
       ▼
vibly-chain solo-node      (OpenGov 链)
       │  ws://
       ▼
vibly-indexer (SubQuery)   (链上事件索引, GraphQL :3010)
```

## 快速开始

```bash
pnpm install
cp .env.example .env          # 或直接依赖默认值
pnpm dev                      # ts-node 开发模式
```

默认监听：`http://localhost:8787`  
默认 API token：`dev-token`  
Swagger UI：`http://localhost:8787/docs`

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NODE_ENV` | `development` | 运行环境 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `DATABASE_URL` | `file:./data/vibly-coordinator.sqlite` | SQLite 文件路径 |
| `STORAGE_MODE` | `sqlite` | `memory` 或 `sqlite` |
| `API_AUTH_MODE` | `static-token` | `none` 或 `static-token` |
| `API_TOKENS` | `dev-token` | 逗号分隔的有效 token |
| `ENABLE_SWAGGER` | `true` | 启用 Swagger UI |
| `SUBSTRATE_INDEXER_URL` | — | SubQuery GraphQL endpoint（设置后启动链上读模型消费者）|
| `SUBSTRATE_CHAIN_ID` | `substrate:vibly-solo` | 链标识符 |

## API 路由

### 基础

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `GET` | `/events` | 事件列表 |
| `GET` | `/events/:eventId` | 单条事件 |
| `GET` | `/streams/events` | SSE 全局事件流 |
| `GET` | `/projects/:projectId/stream` | SSE 项目事件流 |

### 项目与参与者

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST/GET` | `/projects` | 创建/列出项目 |
| `GET` | `/projects/:projectId` | 项目详情 |
| `POST` | `/projects/:projectId/activate\|pause\|archive` | 项目状态变更 |
| `POST/GET` | `/projects/:projectId/objectives` | 目标 |
| `POST/GET` | `/projects/:projectId/boundary` | 边界 |
| `POST` | `/projects/:projectId/boundary/evaluate\|revise` | 边界评估/修订 |
| `POST/GET` | `/principals` | 委托人 |
| `POST/GET` | `/agents` | Agent |
| `POST/GET` | `/projects/:projectId/members` | 成员 |

### 协调流程

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST/GET` | `/actions` | 行动意图 |
| `POST` | `/actions/:actionId/evaluate` | 评估行动 |
| `POST/GET` | `/negotiations` | 协商 |
| `POST` | `/negotiations/:id/positions` | 提交协商立场 |
| `POST` | `/negotiations/:id/delegate-vote` | 委托投票 |
| `POST` | `/negotiations/:id/close\|fork` | 关闭/分叉协商 |
| `GET/POST` | `/work-orders` | 工作单 |
| `POST` | `/work-orders/:id/claim\|submit\|cancel` | 工作单操作 |
| `POST/GET` | `/reviews/requests\|/reviews` | 评审请求/评审 |
| `POST` | `/reviews/aggregate` | 评审聚合 |

### 知识与状态

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/knowledge/latest` | 最新知识版本 |
| `GET` | `/knowledge/versions/:versionId` | 版本详情 |
| `POST/GET` | `/knowledge/candidates\|commits` | 候选/commit |
| `GET` | `/projects/:projectId/state/latest` | 最新状态视图 |
| `POST` | `/projects/:projectId/state/rebuild` | 重建状态 |

### 激励与奖励

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET/POST` | `/rewards` | 奖励意图 |
| `POST` | `/rewards/:id/reserve\|claim` | 预留/领取奖励 |
| `GET` | `/ledger` | 模拟账本摘要 |

### 追踪

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET/POST` | `/traces` | 追踪 |
| `GET` | `/traces/:traceId` | 追踪详情 |
| `POST` | `/traces/:traceId/verify\|replay\|export` | 追踪操作 |

### 治理（Governance）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/governance/intents` | 创建治理意图 |
| `GET` | `/governance/intents/:id` | 获取治理意图 |
| `POST` | `/governance/intents/:id/submit-mock` | Mock 提交（已废弃，设有 `Deprecation: true` 响应头） |
| `GET` | `/governance/views` | 列出链上 governance 读模型（由 SubQuery 消费者写入） |
| `GET` | `/governance/views/:subjectId` | 获取单个链上治理主题（格式：`chainId:referendumIndex`） |
| `GET` | `/governance/checkpoint` | 最新链上索引 checkpoint |

## GovernanceIndexConsumer

设置 `SUBSTRATE_INDEXER_URL` 后，coordinator 在启动时自动运行 `GovernanceIndexConsumer`：

1. 订阅 `SubQueryGovernanceIndexAdapter.feed`（轮询 SubQuery GraphQL，间隔 3 秒）
2. 每收到一个 `NormalizedChainEvent`，写入 `coordinatorStore.saveProjection("governance_view", key, view)`
3. 可通过 `GET /governance/views` 和 `GET /governance/views/:subjectId` 查询

```bash
SUBSTRATE_INDEXER_URL=http://localhost:3010/graphql \
SUBSTRATE_CHAIN_ID=substrate:vibly-solo \
pnpm dev
```

## 开发命令

```bash
pnpm dev          # 开发模式（ts-node）
pnpm build        # 编译 TypeScript
pnpm lint         # Lint
```