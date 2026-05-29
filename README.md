# vibly-coordinator

`vibly-coordinator` is the server-side coordination node for the Vibly network. Built on Fastify and SQLite, it wraps the Concord SDK (`@concord/sdk`) to expose a typed REST/SSE API and optionally syncs on-chain state via the `vibly-indexer` SubQuery endpoint.

> **Single source of truth for the HTTP/SSE contract.** All `vibly-client` and `vibly-console` consumers derive their request/response types from the OpenAPI document this service emits via `@fastify/swagger`. Do not maintain a competing path table in any consumer repository.

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm dev          # development server with hot reload
pnpm build && pnpm start  # production
```

Default endpoint: `http://localhost:8787`

The coordinator scripts load `.env` automatically when it exists. Deployment-provided environment variables still take precedence, so the same scripts are safe for local development, E2E runs, and hosted deployments without a checked-in `.env`.

## Architecture

```
vibly-chain solo-node (ws://9944)
       │
       ▼
vibly-indexer (SubQuery GraphQL :3010)
       │
       ▼
vibly-coordinator (REST/SSE :8787)  ←── @concord/sdk (protocol kernel)
       │
       ├── vibly-client (CLI / daemon)
       └── vibly-console (Web UI)
```

## Environment variables

### Required

| Variable | Description |
|---|---|
| `PORT` | HTTP listen port (default `8787`) |
| `API_AUTH_MODE` | `static-token` or `oidc` |
| `API_TOKENS` | Comma-separated static Bearer tokens (when `static-token`) |
| `STORAGE_MODE` | `sqlite` or `postgres` |
| `DATABASE_URL` | SQLite file path (`file:./data/coordinator.db`) or Postgres DSN |

### Governance / chain integration

| Variable | Description |
|---|---|
| `SUBSTRATE_INDEXER_URL` | SubQuery GraphQL endpoint (e.g. `http://localhost:3010/graphql`) |
| `AGENT_STAKE_SYNC_INTERVAL_MS` | How often to poll the indexer for stake ledger updates (`0` = disabled) |
| `AGENT_STAKE_FRESHNESS_MS` | Maximum age of a stake ledger entry before it is considered stale |
| `SUBSTRATE_STAKE_TX_MODE` | `prepare-only` \| `fixture` \| `unsafe-papi` |
| `SUBSTRATE_CHAIN_ID` | Logical chain identifier (e.g. `substrate:vibly-solo`) |
| `GOVERNANCE_BACKENDS` | Comma-separated backend names to register (`substrate-opengov`, `evm-governor`, …) |

### Get VIB

| Variable | Description |
|---|---|
| `VIBLY_DOT_RECEIVING_ADDRESS` | Deposit address exposed by `GET /get-vib/config`. This must be non-empty or the Console shows "Purchasing is not enabled..." and order creation stays disabled. |
| `GET_VIB_CURVE_PAUSED` | Emergency pause switch for the Get VIB curve. `true` keeps the config visible but disables quoting / buying. |
| `GET_VIB_DOT_USD_PRICE` | Off-chain DOT/USD reference price used to convert a DOT payment budget into a USD-denominated launch-curve quote. |
| `GET_VIB_ADMIN_REVIEW_USD` | USD threshold at or above which a quote / order is marked as requiring admin review. |
| `GET_VIB_RELAY_TOKEN_SYMBOL` | Relay token label shown by the UI (`DOT` for Polkadot, `PLA` for testnet labels, etc.). |
| `GET_VIB_RELAY_TOKEN_DECIMALS` | Relay token decimals used when parsing watched deposits (`10` for DOT). |
| `GET_VIB_RELAY_RPC_URL` | Relay-chain RPC observed by the Get VIB deposit watcher. Leave blank if you only need quoting / manual finalize flows. |
| `GET_VIB_RELAY_CHAIN_ID` | Stable relay-chain id used in observed Get VIB deposit source ids. |
| `GET_VIB_DEPOSIT_SCAN_INTERVAL_MS` | Background watch interval in milliseconds. `0` disables relay deposit scanning. |
| `GET_VIB_DEPOSIT_START_BLOCK` | First relay-chain block the watcher should scan from. |
| `GET_VIB_DEPOSIT_FINALITY_BLOCKS` | Extra finalized blocks to wait before treating a relay deposit as confirmed. |

### Optional

| Variable | Description |
|---|---|
| `LOG_LEVEL` | Pino log level (default `info`) |
| `ENABLE_DEV_ROUTES` | Set `true` to expose scenario / dev-only endpoints |
| `ASSIGNMENT_EXPIRY_INTERVAL_MS` | Assignment expiry check interval (default `60000`) |

### Minimal Get VIB setup

If you only want the Get VIB page to allow quoting and order creation, the minimum coordinator config is:

```env
SUBSTRATE_CHAIN_ID=substrate:vibly-solo
VIBLY_DOT_RECEIVING_ADDRESS=5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY
GET_VIB_CURVE_PAUSED=false
GET_VIB_RELAY_TOKEN_SYMBOL=DOT
GET_VIB_DOT_USD_PRICE=10.98
```

This is enough for `/get-vib/config` to return:

- `purchaseEnabled: true`
- a non-empty `depositAddress`

### Relay watcher setup

If you also want the coordinator to watch finalized relay-chain deposits and auto-create allocations, add:

```env
GET_VIB_RELAY_RPC_URL=wss://rpc.polkadot.io
GET_VIB_RELAY_CHAIN_ID=polkadot
GET_VIB_RELAY_TOKEN_SYMBOL=DOT
GET_VIB_RELAY_TOKEN_DECIMALS=10
GET_VIB_DEPOSIT_SCAN_INTERVAL_MS=5000
GET_VIB_DEPOSIT_START_BLOCK=0
GET_VIB_DEPOSIT_FINALITY_BLOCKS=2
```

After changing these variables, restart `vibly-coordinator`. The package scripts load `.env` automatically, and the Get VIB config endpoint is computed from process env at startup.

## API overview

All responses follow the envelope format:
```json
{ "ok": true, "data": { … }, "meta": { … } }
{ "ok": false, "error": { "code": "…", "message": "…" }, "meta": { … } }
```

## Public Library API

`vibly-coordinator` now exposes a read-only public artifact API for `vibly-library`:

| Route | Description |
|---|---|
| `GET /api/public/artifacts` | List artifacts with filters: `q`, `sort`, `type`, `status`, `org`, `project`, `agent`, `locale`, `limit`, `offset` |
| `GET /api/public/artifacts/popular` | Popular artifacts list (`hotScore` order) |
| `GET /api/public/artifacts/:slug` | Artifact detail by stable public slug |
| `GET /api/public/orgs` | Organizations list |
| `GET /api/public/orgs/:slug` | Organization detail |
| `GET /api/public/projects` | Projects list |
| `GET /api/public/agents` | Agents list |
| `GET /api/public/agents/:id` | Agent detail |

These routes are registered in `src/api/routes/publicLibrary.ts` and are marked `public-read` (no user login required under static token mode).

### Public read models and projector

Public artifacts are served from projection kinds maintained by the coordinator store:

- `public_library_artifact_v1`
- `public_library_org_v1`
- `public_library_project_v1`
- `public_library_agent_v1`

The projector entrypoint is `startPublicLibraryProjector(eventBus, store)` in `src/contexts/library/projector.ts`.
It listens to artifact/knowledge/agent events and continuously refreshes public read models used by `/api/public/*`.

### Domain modules

| Module | Routes |
|---|---|
| **Platform** | `GET /health`, `GET /metrics`, `GET /events`, `GET /projects/:id/stream` (SSE) |
| **Identity** | `POST /principals`, `GET /principals/:id`, `GET /agent-profiles/:id` |
| **Project** | `POST/GET /projects`, `GET /projects/:id/objectives`, `/boundary`, `/read-models` |
| **Workflow** | `POST /action-intents`, `GET /work`, `GET /negotiations`, `GET /reviews`, `GET /assignments`, `GET /traces` |
| **Knowledge** | `GET /knowledge`, `GET /context`, `GET /state`, `GET /observations` |
| **Incentives** | `GET /rewards`, `GET /reputation/events`, `GET /settlement-batches` |
| **Governance** | `GET /governance/merged`, `GET /governance/subjects`, `GET /governance/backends`, `GET /governance/checkpoint` |

### Action intents

All state mutations flow through a single endpoint:

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

## OpenAPI contract

The contract package is generated from this repository's Fastify route schemas:

```bash
# Dump the live OpenAPI document
pnpm dump:openapi

# Regenerate the contract package types
pnpm --filter @vibly/coordinator-http-contract gen
```

CI enforces that both `openapi.json` and the generated `src/generated/types.ts` are committed and up to date.

## Module structure

```
src/
  modules/
    platform/      health, metrics, events, SSE streams
    identity/      principals, agents, memberships
    project/       projects, objectives, boundary, read-models
    workflow/      actions, negotiations, work, reviews, traces, assignments
    knowledge/     context, state, knowledge, observations
    incentives/    rewards, reputation, risk, guardian
    governance/    intents, subjects, merged view, backends
    dev/           development scenarios (ENABLE_DEV_ROUTES=true)
  domain/
    schemas.ts     envelope helpers (envelope, listEnvelope, errorEnvelope, …)
  lib/             Concord SDK instantiation and shared services
```

## Development

```bash
pnpm test          # Vitest unit tests
pnpm lint          # ESLint + verify:openapi + check:response-schemas + tsc
pnpm migrate       # Run database migrations
pnpm studio        # Drizzle Studio (SQLite browser)
```

## Docker

```bash
docker compose up -d   # starts coordinator + optional postgres
```
