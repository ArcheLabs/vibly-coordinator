# vibly-coordinator

`vibly-coordinator` 是 Vibly 网络的**服务端协调节点**。基于 Fastify 和 SQLite 构建，封装 Concord SDK（`@concord/sdk`），对外暴露类型化的 REST/SSE API，并可选地通过 `vibly-indexer` SubQuery 端点同步链上状态。

> **HTTP/SSE 合约的唯一权威来源。** 所有 `vibly-client` 和 `vibly-console` 消费方均从本服务通过 `@fastify/swagger` 生成的 OpenAPI 文档推导请求/响应类型。请勿在任何消费方仓库中维护竞争性路径表。

## 快速开始

```bash
pnpm install
cp .env.example .env
pnpm dev          # 带热重载的开发服务器
pnpm build && pnpm start  # 生产模式
```

默认端点：`http://localhost:8787`

## 架构

```
vibly-chain 单节点（ws://9944）
       │
       ▼
vibly-indexer（SubQuery GraphQL :3010）
       │
       ▼
vibly-coordinator（REST/SSE :8787）  ←── @concord/sdk（协议内核）
       │
       ├── vibly-client（CLI / 守护进程）
       └── vibly-console（Web 控制台）
```

## 环境变量

### 必填

| 变量 | 说明 |
|---|---|
| `PORT` | HTTP 监听端口（默认 `8787`） |
| `API_AUTH_MODE` | `static-token` 或 `oidc` |
| `API_TOKENS` | 逗号分隔的静态 Bearer token（`static-token` 模式） |
| `STORAGE_MODE` | `sqlite` 或 `postgres` |
| `DATABASE_URL` | SQLite 文件路径（`file:./data/coordinator.db`）或 Postgres DSN |

### 治理 / 链集成

| 变量 | 说明 |
|---|---|
| `SUBSTRATE_INDEXER_URL` | SubQuery GraphQL 端点（如 `http://localhost:3010/graphql`） |
| `AGENT_STAKE_SYNC_INTERVAL_MS` | 轮询索引器更新质押账本的间隔（`0` = 禁用） |
| `AGENT_STAKE_FRESHNESS_MS` | 质押账本条目在被视为陈旧前的最大时效 |
| `SUBSTRATE_STAKE_TX_MODE` | `prepare-only` \| `fixture` \| `unsafe-papi` |
| `SUBSTRATE_CHAIN_ID` | 逻辑链标识符（如 `substrate:vibly-solo`） |
| `GOVERNANCE_BACKENDS` | 要注册的后端名称（逗号分隔，如 `substrate-opengov`、`evm-governor`） |

### 可选

| 变量 | 说明 |
|---|---|
| `LOG_LEVEL` | Pino 日志级别（默认 `info`） |
| `ENABLE_DEV_ROUTES` | 设为 `true` 以暴露场景 / 仅开发端点 |
| `ASSIGNMENT_EXPIRY_INTERVAL_MS` | 任务分配过期检查间隔（默认 `60000`） |

## API 概览

所有响应遵循信封格式：
```json
{ "ok": true, "data": { … }, "meta": { … } }
{ "ok": false, "error": { "code": "…", "message": "…" }, "meta": { … } }
```

### 领域模块

| 模块 | 路由 |
|---|---|
| **平台** | `GET /health`、`GET /metrics`、`GET /events`、`GET /projects/:id/stream`（SSE） |
| **身份** | `POST /principals`、`GET /principals/:id`、`GET /agent-profiles/:id` |
| **项目** | `POST/GET /projects`、`GET /projects/:id/objectives`、`/boundary`、`/read-models` |
| **工作流** | `POST /action-intents`、`GET /work`、`GET /negotiations`、`GET /reviews`、`GET /assignments`、`GET /traces` |
| **知识** | `GET /knowledge`、`GET /context`、`GET /state`、`GET /observations` |
| **激励** | `GET /rewards`、`GET /reputation/events`、`GET /settlement-batches` |
| **治理** | `GET /governance/merged`、`GET /governance/subjects`、`GET /governance/backends`、`GET /governance/checkpoint` |

### 动作意图

所有状态变更通过单一端点流转：

```http
POST /action-intents
Authorization: Bearer <token>
Content-Type: application/json

{
  "type": "CreateObservationTask",
  "principalId": "principal_...",
  "payload": { … }
}
```

## OpenAPI 合约

合约包从本仓库的 Fastify 路由 Schema 生成：

```bash
# 导出实时 OpenAPI 文档
pnpm dump:openapi

# 重新生成合约包类型
pnpm --filter @vibly/coordinator-http-contract gen
```

CI 强制要求 `openapi.json` 和生成的 `src/generated/types.ts` 均已提交且保持最新。

## 模块结构

```
src/
  modules/
    platform/      健康检查、指标、事件、SSE 流
    identity/      委托人、代理、成员关系
    project/       项目、目标、边界、读模型
    workflow/      动作、协商、工作、审核、追踪、任务分配
    knowledge/     上下文、状态、知识、观察
    incentives/    奖励、信誉、风险、守护
    governance/    意图、主题、合并视图、后端
    dev/           开发场景（ENABLE_DEV_ROUTES=true）
  domain/
    schemas.ts     信封助手（envelope、listEnvelope、errorEnvelope 等）
  lib/             Concord SDK 实例化与共享服务
```

## 开发

```bash
pnpm test          # Vitest 单元测试
pnpm lint          # ESLint + verify:openapi + check:response-schemas + tsc
pnpm migrate       # 运行数据库迁移
pnpm studio        # Drizzle Studio（SQLite 浏览器）
```

## Docker

```bash
docker compose up -d   # 启动协调器 + 可选的 Postgres
```
