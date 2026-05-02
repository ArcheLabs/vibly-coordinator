# vibly-coordinator — Agent Operating Rules

This file lists invariants every Cursor agent (and human contributor) must obey when working in `vibly-coordinator`. Violations should block PRs.

## Role

`vibly-coordinator` is the **single source of truth for the Coordinator HTTP/SSE contract**. The `@vibly/coordinator-http-contract` package and all consumers (`vibly-client`, `vibly-console`) derive their request/response types from the OpenAPI document this app emits via `@fastify/swagger`.

```
src/modules/<domain>/…/routes.ts  ← Fastify routes with full schema (body/query/params/RESPONSE)
  Domains: platform (health, metrics, events, streams),
  knowledge (context, state, knowledge, observations),
  identity (principals, agents, memberships),
  project (projects, objectives, boundary, read-models),
  workflow (actions, negotiations, work, reviews, traces, assignments),
  incentives (rewards, reputation, risk, guardian),
  governance (aggregate routes.ts → intents, subjects, merged, backends, shared),
  dev (scenarios)
        │ pnpm dump:openapi
        ▼
@vibly/coordinator-http-contract/openapi.json
        │ pnpm --filter @vibly/coordinator-http-contract gen
        ▼
src/generated/types.ts            ← consumed by vibly-client and vibly-console
```

## Invariants

1. **Every route MUST declare `schema.response[200]` — 100% coverage is a hard constraint.** Use the helpers in `src/domain/schemas.ts` (`envelope`, `envelopeKey`, `listEnvelope`, `errorEnvelope`). For SSE streams, declare `200` with `content["text/event-stream"]` (see `modules/platform/streams/routes.ts`). Body/querystring/params schemas alone are not enough; openapi-fetch consumers cannot type the response without it. Local/CI `pnpm lint` runs `verify:openapi`, `verify:contract-types` (sibling `vibly-coordinator-http-contract` 脚本), `check:response-schemas` (default `--max-missing 0`), then `tsc`.
2. **Adding/changing a route MUST refresh `openapi.json`.** Run `pnpm dump:openapi` and commit the result in the same PR. CI runs `pnpm verify:openapi` to detect drift.
3. **Adding/changing a route MUST refresh contract types.** Run `pnpm --filter @vibly/coordinator-http-contract gen` and commit the new `src/generated/types.ts`. CI runs `verify:types` to detect drift.
4. **Do not edit `openapi.json` or `src/generated/types.ts` by hand.** Both are generated; if you need to influence them, change the route schema and re-run the generators.
5. **Do not introduce a competing HTTP path table or "second source of truth" client wrapper inside this app.** Consumers must consume `@vibly/coordinator-http-contract` directly; this app does not ship a separate REST client. CLI/dev scripts that need to call the API can use the contract client themselves.
6. **The HTTP envelope is `{ ok, data, page?, meta }`.** Do not invent route-level alternatives. Errors are `{ ok: false, error: { code, message, details? }, meta }`.

## When in doubt

- Need to expose new data? Add a route with a tight `response.200` schema. Prefer wrapping payloads in a named key under `data` (e.g. `{ project }`, `{ trace }`) for readability.
- Need to expose data only to one consumer? Still declare the response schema. Consumers are free to ignore the route, but the contract must be testable.
- Need a non-2xx code? Add it to the route schema (e.g. `404`) so consumers can branch typed.
