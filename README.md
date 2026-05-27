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
| `GET_VIB_RELAY_RPC_URL` | Relay-chain RPC observed by Get VIB deposit watcher |
| `GET_VIB_RELAY_CHAIN_ID` | Relay-chain id used in observed Get VIB deposit source ids |
| `GET_VIB_RELAY_TOKEN_SYMBOL` | Relay token displayed by Get VIB (`DOT` for Polkadot mainnet, `PLA` for testnet) |

### Optional

| Variable | Description |
|---|---|
| `LOG_LEVEL` | Pino log level (default `info`) |
| `ENABLE_DEV_ROUTES` | Set `true` to expose scenario / dev-only endpoints |
| `ASSIGNMENT_EXPIRY_INTERVAL_MS` | Assignment expiry check interval (default `60000`) |

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
