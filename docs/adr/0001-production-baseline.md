# ADR-0001: Production baseline for vibly-coordinator

## Status

Accepted — 2026-05-01

## Context

The coordinator shipped as a single-process Fastify app with SQLite, static bearer tokens, in-process SSE fan-out, and no production-grade client compatibility gate. As `@vibly-ai/client` moved toward public npm distribution and self-upgrade, the coordinator also needed to become the authority for minimum supported client and contract versions.

## Decision

Production deployments MUST use:

- **Persistence**: `STORAGE_MODE=postgres` with `DATABASE_URL` pointing at PostgreSQL.
- **Authentication**: `API_AUTH_MODE=oidc` with `OIDC_ISSUER`, `OIDC_AUDIENCE`, and `OIDC_JWKS_URL`; JWT validated via `jose`.
- **Authorization**: `request.auth` carries scopes and optional project IDs; `coord:admin` bypasses fine-grained checks.
- **Realtime**: SSE via `/streams/events` and `/projects/:projectId/stream`, with daemon heartbeat support through `POST /agents/:id/heartbeat`.
- **Compatibility policy**: `CLIENT_VERSION_ENFORCEMENT=true`, plus explicit `MINIMUM_CLIENT_VERSION`, `RECOMMENDED_CLIENT_VERSION`, `MINIMUM_CONTRACT_VERSION`, and `UPGRADE_INSTRUCTIONS_URL`.
- **Observability**: Request IDs on Fastify; OpenTelemetry when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; `/metrics` and `/ready` exposed for health systems.

SQLite and static tokens remain valid for `development` and `test` only. `NODE_ENV=production` enforces the above via `loadConfig()`.

## Consequences

- Production coordinators can reject stale clients early with `UPGRADE_REQUIRED` instead of allowing undefined behavior.
- Client upgrade orchestration is split cleanly: coordinator publishes policy and validates headers; clients pause duties, drain work, upgrade, verify, then resume.
- Concord remains storage-agnostic: when coordinator uses Postgres, Concord core still does not become an HTTP owner or product contract authority.
