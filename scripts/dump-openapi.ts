/**
 * Dumps the live OpenAPI document produced by `@fastify/swagger` to
 * `vibly-coordinator-http-contract/openapi.json`. Run via:
 *
 *   pnpm --filter vibly-coordinator dump:openapi
 *
 * CI uses `verify:openapi` to ensure the checked-in artifact stays in sync
 * with the route schemas. The script intentionally avoids real SDK / SQLite
 * wiring (those require Node features not always available on Node 20) and
 * instead injects minimal stubs - we only need swagger schema introspection.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Concord } from "@concord/sdk";
import { createApp } from "../src/createApp.js";
import { CoordinatorStore } from "../src/db/coordinatorStore.js";
import { createEventBus } from "../src/services/eventBus.js";
import { loadConfig } from "../src/config/env.js";
import { createLogger } from "../src/config/logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(here, "../../vibly-coordinator-http-contract/openapi.json");

function makeStubStore(): CoordinatorStore {
  const projections = new Map<string, Map<string, unknown>>();
  return {
    saveProjection: (kind: string, id: string, value: unknown) => {
      const bucket = projections.get(kind) ?? new Map<string, unknown>();
      bucket.set(id, value);
      projections.set(kind, bucket);
    },
    getProjection: (kind: string, id: string) => projections.get(kind)?.get(id) ?? null,
    listProjections: (kind: string) => Array.from(projections.get(kind)?.values() ?? []),
  } as unknown as CoordinatorStore;
}

function makeStubConcord(): Concord {
  return {
    governanceIndexQuery: null,
    governanceGateway: { submitProposal: async () => ({ id: "stub", status: "submitted" }) },
    state: { events: { append: async () => {} } },
  } as unknown as Concord;
}

async function main() {
  const config = loadConfig({
    NODE_ENV: "test",
    API_AUTH_MODE: "none",
    STORAGE_MODE: "memory",
    ENABLE_SWAGGER: "true",
    ENABLE_DEV_ROUTES: "false",
    LOG_LEVEL: "warn",
    PORT: "0",
  } as NodeJS.ProcessEnv);
  const logger = createLogger(config);

  const app = await createApp({
    config,
    logger,
    concord: makeStubConcord(),
    coordinatorStore: makeStubStore(),
    eventBus: createEventBus(),
    startGovernanceConsumers: false,
  });
  await app.ready();

  const swagger = (app as unknown as { swagger: () => Record<string, unknown> }).swagger();
  const output = process.argv[2] ?? DEFAULT_OUTPUT;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(swagger, null, 2)}\n`, "utf8");

  await app.close();
  console.log(`OpenAPI written to ${output}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
