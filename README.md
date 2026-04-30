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
| `ENABLE_DEV_ROUTES` | `false` | 启用本地 dev-only seed/smoke 路由 |
| `GOVERNANCE_BACKENDS` | — | 可选 allowlist，例如 `substrate-local,evm-fixture` |
| `SUBSTRATE_INDEXER_URL` | — | SubQuery GraphQL endpoint（设置后启动链上读模型消费者）|
| `SUBSTRATE_CHAIN_ID` | `substrate:vibly-solo` | 链标识符 |
| `SUBSTRATE_RPC_URL` | `ws://127.0.0.1:9944` | Substrate OpenGov 写路径 RPC |
| `SUBSTRATE_GOVERNANCE_TX_MODE` | `prepare-only` | `prepare-only`、`fixture` 或 `unsafe-papi` |
| `EVM_GOVERNOR_FIXTURE` | `false` | 启用 EVM Governor fixture backend |
| `EVM_CHAIN_ID` | `31337` | EVM fixture 的 EIP-155 chain id |

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

### Phase F Test Agent Collaboration

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/phase-f/smoke` | dev-only：运行 Observer/Delegate/Worker/Reviewer/Guardian 协作 smoke |
| `GET` | `/phase-f/runs` | 列出 Phase F smoke run projection |
| `GET` | `/guardian-requests` | 查询 Guardian/high-risk request read model |

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
| `POST` | `/governance/intents/:id/submit-opengov` | Phase E 主路径：通过 Substrate OpenGov action adapter 提交治理意图 |
| `POST` | `/governance/intents/:id/reconcile-subject` | 将已提交 intent 与 indexer 回读到的 subject 关联 |
| `POST` | `/governance/subjects/:subjectId/vote-opengov` | 通过 coordinator 提交 OpenGov vote，并等待 indexer 回读 |
| `GET` | `/governance/views` | 列出链上 governance 读模型（由 SubQuery 消费者写入） |
| `GET` | `/governance/views/:subjectId` | 获取单个链上治理主题（格式：`chainId:referendumIndex`） |
| `GET` | `/governance/checkpoint?backend=...` | 最新链上索引 checkpoint，可按 backend/chain 过滤 |
| `GET` | `/governance/subjects?backend=...` | typed governance subjects，可按 backend 过滤 |
| `GET` | `/governance/merged?backend=...` | 合并治理视图，可按 backend 过滤 |
| `GET` | `/governance/backends` | 已注册 backend descriptor、capability 与 health/freshness |

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

Phase D.5 多 backend demo 同时启用 Substrate OpenGov 与 EVM fixture：

```bash
GOVERNANCE_BACKENDS=substrate-local,evm-fixture \
SUBSTRATE_INDEXER_URL=http://localhost:3010/graphql \
SUBSTRATE_CHAIN_ID=substrate:vibly-solo \
EVM_GOVERNOR_FIXTURE=true \
EVM_CHAIN_ID=31337 \
ENABLE_DEV_ROUTES=true \
pnpm dev
```

规范 backend descriptor id：

- `substrate-local`：`backend=substrate-opengov`，`chain.namespace=substrate`。
- `evm-fixture`：`backend=evm-governor`，`chain.namespace=eip155`，`chainId=31337`。

`/governance/backends` 会返回 backend-neutral `health` 字段，包含 `status`、`stale`、`reason`、`lastObservedAt` 与最新 checkpoint。health/freshness 按 backend chain 计算，不使用全局 checkpoint。

Phase E 主路径使用 coordinator action API 写入 OpenGov，然后通过 indexer/projector 回读。`/governance/merged` 会返回 `actionReceipts`、`submitReceipt`、`voteReceipts` 与 `readback`，用于解释提交交易、pending indexer、linked subject 和 vote readback 状态。

本地 smoke 可先用 fixture tx mode 验证 coordinator 闭环形状：

```bash
SUBSTRATE_GOVERNANCE_TX_MODE=fixture pnpm dev
./scripts/phase-e-smoke.sh
```

真实链 smoke 需要启动 `vibly-chain` solo-node 与 `vibly-indexer`，并将 `SUBSTRATE_GOVERNANCE_TX_MODE` 切换为可提交的 PAPI signer/submitter 路径；indexer 看到 referendum 后，用 `SUBJECT_EXTERNAL_ID=<referendumIndex> ./scripts/phase-e-smoke.sh` 进行 reconcile。

本地演示可使用 dev-only seed 路由稳定生成 Substrate + EVM 两类 merged 条目：

```bash
curl -X POST -H "Authorization: Bearer dev-token" http://localhost:8787/governance/dev/seed-demo
curl -H "Authorization: Bearer dev-token" http://localhost:8787/governance/merged
```

Phase F 本地协作 smoke 需要启用 dev routes：

```bash
ENABLE_DEV_ROUTES=true pnpm dev
curl -X POST -H "Authorization: Bearer dev-token" http://localhost:8787/phase-f/smoke
curl -H "Authorization: Bearer dev-token" http://localhost:8787/phase-f/runs
```

该 smoke 会写入五个测试 Agent、high-risk action、Guardian request、structured negotiation、accepted work order、review aggregation，并生成可 verify/replay 的 trace。

## 开发命令

```bash
pnpm dev          # 开发模式（ts-node）
pnpm build        # 编译 TypeScript
pnpm lint         # Lint
```