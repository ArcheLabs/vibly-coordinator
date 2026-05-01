# ADR-0001: Production baseline for vibly-coordinator

## Status

Accepted — 2026-05-01

## Context

The coordinator shipped as a single-process Fastify app with SQLite (`node:sqlite`), static bearer tokens, in-process SSE fan-out, and an unused `events` DDL that collided with `@concord/state` when both opened the same SQLite file.

## Decision

Production deployments MUST use:

- **Persistence**: `STORAGE_MODE=postgres` with `DATABASE_URL` pointing at PostgreSQL; Drizzle + SQL migrations under `src/db/postgres/migrations/`.
- **Authentication**: `API_AUTH_MODE=oidc` with `OIDC_ISSUER`, `OIDC_AUDIENCE`, and `OIDC_JWKS_URL`; JWT validated via `jose`.
- **Authorization**: `request.auth` carries scopes and optional project IDs; `coord:admin` bypasses fine-grained checks.
- **Realtime**: Postgres `LISTEN/NOTIFY` + `coordinator_broadcast_events` for cross-instance SSE; optional replay via `Last-Event-ID`.
- **Observability**: Request IDs on Fastify; OpenTelemetry when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; `/metrics` (Prometheus) and `/ready` (readiness).

SQLite and static tokens remain valid for `development` / `test` only. `NODE_ENV=production` enforces the above via `loadConfig()` (fail-fast).

## Consequences

- No production “single SQLite file” topology for coordinator operational data.
- Concord stays storage-agnostic: when coordinator uses Postgres, Concord core uses in-memory (or separate SQLite) via `getOrCreateConcord()`.
- Coordinator-owned tables are prefixed `coordinator_*` to avoid accidental collisions.
