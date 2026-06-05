# vibly-coordinator

`vibly-coordinator` is the server-side coordination node for the Vibly network. Built on Fastify and SQLite or Postgres, it wraps the Concord SDK (`@concord/sdk`) to expose a typed REST/SSE API, enforces client version policy, and optionally syncs on-chain state via the `vibly-indexer` SubQuery endpoint.

> **Single source of truth for the HTTP/SSE contract.** All `vibly-client` and `vibly-console` consumers derive their request and response types from the OpenAPI document this service emits via `@fastify/swagger`. Do not maintain a competing path table in any consumer repository.

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm dev
pnpm build && pnpm start
```

Default endpoint: `http://localhost:8787`

The coordinator scripts load `.env` automatically when it exists. Deployment-provided environment variables still take precedence, so the same scripts are safe for local development, E2E runs, and hosted deployments without a checked-in `.env`.

## Architecture

```
vibly-chain solo-node (ws://9944)
       |
       v
vibly-indexer (SubQuery GraphQL :3010)
       |
       v
vibly-coordinator (REST/SSE :8787)  <--- @concord/sdk (protocol kernel)
       |
       +-- vibly-client (CLI / daemon)
       +-- vibly-console (Web UI)
```

## Production topology

The production coordinator process can be hosted on a stateless platform such as Cloud Run, but the system as a whole is not serverless:

- `vibly-coordinator`: stateless app container
- `Postgres`: required persistent database in production
- `vibly-indexer`: separate SubQuery deployment that feeds chain read models
- `vibly-chain`: separate chain node / RPC endpoint

Coordinator startup already handles database connectivity checks and migrations, so the deployment model is:

1. Provision Postgres first.
2. Set `STORAGE_MODE=postgres` and `DATABASE_URL=postgres://...`.
3. Point `SUBSTRATE_INDEXER_URL` at the hosted SubQuery GraphQL endpoint.
4. Start the coordinator container; it will ping/migrate Postgres on boot.

For Google Cloud, the usual split is Cloud Run for the coordinator app plus Cloud SQL for Postgres.

Ready-to-copy deployment templates:

- [templates/cloud-run.env.yaml.example](/home/libingjiang47/vibly-coordinator/templates/cloud-run.env.yaml.example)
- [templates/network-manifest.production.json.example](/home/libingjiang47/vibly-coordinator/templates/network-manifest.production.json.example)

Typical deploy command:

```bash
gcloud run deploy vibly-coordinator \
  --source . \
  --region asia-east1 \
  --project your-gcp-project \
  --allow-unauthenticated \
  --add-cloudsql-instances your-gcp-project:asia-east1:vibly-coordinator-pg \
  --env-vars-file templates/cloud-run.env.yaml.example
```

The env file intentionally includes `DATABASE_URL` as a placeholder because many teams start with a private Cloud SQL Unix socket DSN. If you manage secrets separately, replace it at deploy time with `--set-secrets` or your secret manager workflow.

## Version policy and upgrade gates

Coordinator is the authority for client compatibility. It now exposes:

- `GET /version-policy` for minimum and recommended client versions.
- Request-time validation of `X-Vibly-Client-Package`, `X-Vibly-Client-Version`, `X-Vibly-Contract-Version`, and `X-Vibly-Protocol-Version` headers.
- Typed `UPGRADE_REQUIRED` responses with HTTP `426` for protected routes when the client is too old.
- `POST /agents/:id/heartbeat` so daemons can report current version, availability, and upgrade phase.

Public endpoints such as `/health`, `/ready`, `/metrics`, `/openapi.json`, and `/version-policy` remain accessible without version enforcement.

## Environment variables

### Required

| Variable | Description |
|---|---|
| `PORT` | HTTP listen port (default `8787`) |
| `API_AUTH_MODE` | `static-token` or `oidc` |
| `API_TOKENS` | Comma-separated static Bearer tokens (when `static-token`) |
| `STORAGE_MODE` | `sqlite` or `postgres` |
| `DATABASE_URL` | SQLite file path (`file:./data/coordinator.db`) or Postgres DSN |

### Client version policy

| Variable | Description |
|---|---|
| `CLIENT_VERSION_ENFORCEMENT` | Enable request-time version gating; must be `true` in production |
| `MINIMUM_CLIENT_VERSION` | Minimum supported `@vibly-ai/client` version |
| `RECOMMENDED_CLIENT_VERSION` | Coordinator-preferred client version for upgrade prompts |
| `MINIMUM_CONTRACT_VERSION` | Minimum supported `@vibly-ai/coordinator-http-contract` version |
| `UPGRADE_DEADLINE` | Optional ISO timestamp for forced upgrade rollout |
| `UPGRADE_INSTRUCTIONS_URL` | URL shown in `UPGRADE_REQUIRED` details |
| `PROTOCOL_VERSION` | Logical coordinator protocol version sent back in policy responses |
| `NETWORK_MANIFEST_JSON` | Public network manifest array for `/networks`; required in production, empty uses built-in local/prelaunch defaults only outside production |

When you publish named public networks, keep the current product naming aligned with Console:

- `substrate:vibly-testnet` -> `Lumen`
- `substrate:vibly-incentivized-testnet` -> `Monolith`

### Governance and chain integration

| Variable | Description |
|---|---|
| `SUBSTRATE_INDEXER_URL` | SubQuery GraphQL endpoint (for example `http://localhost:3010/graphql`) |
| `CORS_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call Coordinator directly, e.g. a static Console on GitHub Pages |
| `AGENT_STAKE_SYNC_INTERVAL_MS` | How often to poll the indexer for stake ledger updates (`0` = disabled) |
| `AGENT_STAKE_FRESHNESS_MS` | Maximum age of a stake ledger entry before it is considered stale |
| `SUBSTRATE_STAKE_TX_MODE` | `prepare-only`, `fixture`, or `unsafe-papi` |
| `GET_VIB_ROOT_UPLOAD_INTERVAL_MS` | How often to build/upload Get VIB claim roots (`0` = disabled, default `120000`) |
| `GET_VIB_ROOT_UPLOAD_MODE` | `prepare-only`, `fixture`, or `unsafe-papi` for direct `vibClaim.setClaimRoot` submission |
| `GET_VIB_ROOT_PUBLISHER_URI` | Hot-key URI authorized on-chain only as the Get VIB claim root publisher; do not use sudo/root here |
| `CHAIN_AUTHORITY_MODE` | Guardian authority resolver mode. Production requires `rpc` |
| `CHAIN_AUTHORITY_RPC_URL` | Vibly Chain RPC used to read `guardianMembership.members()`; falls back to `SUBSTRATE_RPC_URL` |
| `ORG_ADMIN_AUTHORITY_SOURCE` | `guardian` requires chain Guardian membership for organization admin writes; production rejects `local` |
| `SUBSTRATE_CHAIN_ID` | Logical chain identifier (for example `substrate:vibly-solo`) |
| `GOVERNANCE_BACKENDS` | Comma-separated backend names to register (`substrate-opengov`, `evm-governor`, ...) |

Generate or inspect a dedicated Get VIB root publisher hot key with:
`pnpm get-vib-root-publisher:generate`
or
`pnpm get-vib-root-publisher:inspect -- --uri '<mnemonic or derivation URI>'`

`SUBSTRATE_INDEXER_URL` must point at a real hosted `vibly-indexer` deployment in production. The coordinator does not embed SubQuery or manage the indexer lifecycle for you.

### Optional

| Variable | Description |
|---|---|
| `LOG_LEVEL` | Pino log level (default `info`) |
| `ENABLE_DEV_ROUTES` | Set `true` to expose scenario and dev-only endpoints |
| `ASSIGNMENT_EXPIRY_INTERVAL_MS` | Assignment expiry check interval |
| `SSE_HEARTBEAT_MS` | SSE keepalive interval |

## API overview

All responses follow the envelope format:

```json
{ "ok": true, "data": { ... }, "meta": { ... } }
{ "ok": false, "error": { "code": "...", "message": "..." }, "meta": { ... } }
```

### Platform and compatibility routes

| Route | Description |
|---|---|
| `GET /health` | Liveness information |
| `GET /ready` | Readiness information |
| `GET /metrics` | Prometheus metrics |
| `GET /version-policy` | Published client compatibility policy |
| `GET /streams/events` | Global SSE stream |
| `GET /projects/:projectId/stream` | Project SSE stream |

### Agent-specific operational routes

| Route | Description |
|---|---|
| `GET /organizations/:organizationId/agents/:principalId/join-eligibility` | Check whether an agent can join an organization |
| `POST /agents/:id/heartbeat` | Record daemon heartbeat, availability, and upgrade phase |
| `GET /agents/:id/inbox` | Agent-facing work and notification snapshot |
| `GET /agent-stakes` | Stake ledger read model synced from the indexer |

### Action intents

All state mutations flow through a single endpoint:

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

Join, pause-duty, resume-duty, and other protocol writes continue to use this path.

## OpenAPI contract

The contract package is generated from this repository's Fastify route schemas:

```bash
pnpm dump:openapi
pnpm --filter @vibly-ai/coordinator-http-contract gen
```

CI enforces that both `openapi.json` and the generated `src/generated/types.ts` are committed and up to date.

## Development

```bash
pnpm test
pnpm lint
pnpm build
```
