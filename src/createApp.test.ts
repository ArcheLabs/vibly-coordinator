import { describe, expect, it } from "vitest";
import { createApp } from "./createApp.js";
import { loadConfig } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { CoordinatorStore } from "./db/coordinatorStore.js";
import { createEventBus } from "./services/eventBus.js";
import type { Concord } from "@concord/sdk";

function makeStore(): CoordinatorStore {
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

function makeConcord(): Concord {
  return {
    governanceIndexQuery: null,
    governanceGateway: {
      submitProposal: async () => ({ id: "mock", status: "submitted" }),
    },
    state: {
      events: { append: async () => {} },
    },
  } as unknown as Concord;
}

describe("createApp governance runtime config", () => {
  it("can register substrate-local and evm-fixture descriptors in one process", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "none",
      GOVERNANCE_BACKENDS: "substrate-local,evm-fixture",
      SUBSTRATE_INDEXER_URL: "http://localhost:3010/graphql",
      SUBSTRATE_CHAIN_ID: "substrate:vibly-solo",
      EVM_CHAIN_ID: "31337",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const res = await app.inject({ method: "GET", url: "/governance/backends" });
    const body = res.json<{ data: { backends: { id: string; backend: string; chain: { namespace: string; chainId: string } }[] } }>();

    expect(body.data.backends).toMatchObject([
      {
        id: "substrate-local",
        backend: "substrate-opengov",
        chain: { namespace: "substrate", chainId: "substrate:vibly-solo" },
      },
      {
        id: "evm-fixture",
        backend: "evm-governor",
        chain: { namespace: "eip155", chainId: "31337" },
      },
    ]);

    await app.close();
  });

  it("keeps the legacy single-backend substrate path", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "none",
      SUBSTRATE_INDEXER_URL: "http://localhost:3010/graphql",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const res = await app.inject({ method: "GET", url: "/governance/backends" });
    const body = res.json<{ data: { backends: { id: string; backend: string }[] } }>();

    expect(body.data.backends).toHaveLength(1);
    expect(body.data.backends[0]).toMatchObject({
      id: "substrate-local",
      backend: "substrate-opengov",
    });

    await app.close();
  });
});
