# vibly-coordinator

`vibly-coordinator` 是 Vibly 网络的服务端协调节点。它基于 Fastify，使用 SQLite 或 Postgres 作为存储后端，封装 `@concord/sdk` 暴露类型化的 REST / SSE API，并可通过 `vibly-indexer` 同步链上状态。

> **HTTP / SSE 合约的唯一权威。** `@vibly-ai/client`、`vibly-console` 等消费者都必须从本仓库导出的 OpenAPI 合约生成类型，不能维护竞争性的路径表。

## 快速开始

```bash
pnpm install
cp .env.example .env
pnpm dev
pnpm build && pnpm start
```

默认地址：`http://localhost:8787`

## 版本策略与升级门禁

coordinator 现在负责客户端兼容性策略，提供以下能力：

- `GET /version-policy`：发布最低支持版本、推荐版本、最小 contract 版本。
- 对受保护请求校验 `X-Vibly-Client-Package`、`X-Vibly-Client-Version`、`X-Vibly-Contract-Version`、`X-Vibly-Protocol-Version`。
- 客户端版本过低时返回 HTTP `426` 和 typed `UPGRADE_REQUIRED` 错误。
- `POST /agents/:id/heartbeat`：记录 daemon 当前版本、可用状态和升级阶段。

`/health`、`/ready`、`/metrics`、`/openapi.json`、`/version-policy` 等公共路径不受版本门禁限制。

## 关键环境变量

### 必填

| 变量 | 说明 |
|---|---|
| `PORT` | HTTP 监听端口，默认 `8787` |
| `API_AUTH_MODE` | `static-token` 或 `oidc` |
| `API_TOKENS` | `static-token` 模式下使用的 Bearer token 列表 |
| `STORAGE_MODE` | `sqlite` 或 `postgres` |
| `DATABASE_URL` | SQLite 文件路径或 Postgres DSN |

### 客户端版本策略

| 变量 | 说明 |
|---|---|
| `CLIENT_VERSION_ENFORCEMENT` | 是否启用请求级版本门禁；生产环境必须为 `true` |
| `MINIMUM_CLIENT_VERSION` | 最低支持的 `@vibly-ai/client` 版本 |
| `RECOMMENDED_CLIENT_VERSION` | 推荐升级到的客户端版本 |
| `MINIMUM_CONTRACT_VERSION` | 最低支持的 `@vibly-ai/coordinator-http-contract` 版本 |
| `UPGRADE_DEADLINE` | 可选的升级截止时间（ISO 时间戳） |
| `UPGRADE_INSTRUCTIONS_URL` | 升级说明链接，会出现在 `UPGRADE_REQUIRED` 详情中 |
| `PROTOCOL_VERSION` | 当前协调器发布的逻辑协议版本 |

### 链与治理集成

| 变量 | 说明 |
|---|---|
| `SUBSTRATE_INDEXER_URL` | SubQuery GraphQL 地址 |
| `AGENT_STAKE_SYNC_INTERVAL_MS` | 质押账本同步间隔，`0` 表示关闭 |
| `AGENT_STAKE_FRESHNESS_MS` | 质押账本可接受的新鲜度阈值 |
| `SUBSTRATE_STAKE_TX_MODE` | `prepare-only`、`fixture` 或 `unsafe-papi` |
| `GET_VIB_ROOT_UPLOAD_INTERVAL_MS` | Get VIB claim root 生成并上传间隔，`0` 表示关闭，默认 `600000` |
| `GET_VIB_ROOT_UPLOAD_MODE` | `prepare-only`、`fixture` 或 `unsafe-papi`，直接提交 `vibClaim.setClaimRoot` |
| `GET_VIB_ROOT_PUBLISHER_URI` | 链上授权的 Get VIB claim root publisher 热号 URI；不要使用 sudo/root 账号 |
| `SUBSTRATE_CHAIN_ID` | 逻辑链标识 |
| `GOVERNANCE_BACKENDS` | 需要注册的治理后端列表 |

## API 概览

所有响应都遵循统一 envelope：

```json
{ "ok": true, "data": { ... }, "meta": { ... } }
{ "ok": false, "error": { "code": "...", "message": "..." }, "meta": { ... } }
```

### 平台与兼容性路由

| 路由 | 说明 |
|---|---|
| `GET /health` | 存活检查 |
| `GET /ready` | 就绪检查 |
| `GET /metrics` | Prometheus 指标 |
| `GET /version-policy` | 发布客户端兼容性策略 |
| `GET /streams/events` | 全局 SSE 流 |
| `GET /projects/:projectId/stream` | 项目级 SSE 流 |

### Agent 运行相关路由

| 路由 | 说明 |
|---|---|
| `GET /organizations/:organizationId/agents/:principalId/join-eligibility` | 检查代理是否满足加入组织的条件 |
| `POST /agents/:id/heartbeat` | 记录 daemon heartbeat、可用状态与升级阶段 |
| `GET /agents/:id/inbox` | 读取代理视角的任务与通知快照 |
| `GET /agent-stakes` | 读取从 indexer 同步来的质押账本 |

### Action intent

所有写操作仍统一通过 `POST /action-intents` 进入。

```http
POST /action-intents
Authorization: Bearer <token>
Content-Type: application/json

{
  "type": "CreateObservationTask",
  "principalId": "principal_...",
  "payload": { ... }
}
```

组织加入、暂停职责、恢复职责等协议层写操作都继续走这条路径。

## OpenAPI 合约

```bash
pnpm dump:openapi
pnpm --filter @vibly-ai/coordinator-http-contract gen
```

CI 会校验 `openapi.json` 和生成后的 `src/generated/types.ts` 是否保持同步。

## 开发

```bash
pnpm test
pnpm lint
pnpm build
```
