import { describe, expect, it } from "vitest";
import { createApp } from "./createApp.js";
import { loadConfig } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import type { CoordinatorStorePort } from "./db/coordinatorStorePort.js";
import { createEventBus } from "./services/eventBus.js";
import type { Concord } from "@concord/sdk";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";

function makeStore(): CoordinatorStorePort {
  const projections = new Map<string, Map<string, unknown>>();
  return {
    async saveProjection(kind: string, id: string, value: unknown) {
      const bucket = projections.get(kind) ?? new Map<string, unknown>();
      bucket.set(id, value);
      projections.set(kind, bucket);
    },
    async getProjection(kind: string, id: string) {
      return (projections.get(kind)?.get(id) ?? undefined) as never;
    },
    async listProjections(kind: string) {
      return Array.from(projections.get(kind)?.values() ?? []) as never;
    },
    async deleteProjection(kind: string, id: string) {
      projections.get(kind)?.delete(id);
    },
    async createLease() {
      throw new Error("not implemented");
    },
    async getLease() {
      return undefined;
    },
    async getActiveLease() {
      return undefined;
    },
    async renewLease() {
      return undefined;
    },
    async releaseLease() {},
    async sweepExpiredLeases() {
      return [];
    },
  };
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

  it("allows anonymous access to public-read routes in static-token mode", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const response = await app.inject({ method: "GET", url: "/feed" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; data: { items: unknown[] } }>();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);

    await app.close();
  });

  it("rejects anonymous access to private and write routes in static-token mode", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const privateRead = await app.inject({ method: "GET", url: "/agents/demo/inbox" });
    const write = await app.inject({
      method: "POST",
      url: "/action-intents",
      payload: { type: "Ping", principalId: "p1", payload: {} },
    });

    expect(privateRead.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);

    await app.close();
  });

  it("supports wallet challenge/session lifecycle for polkadot signatures", async () => {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const pair = keyring.addFromUri("//Alice");

    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const challengeRes = await app.inject({
      method: "POST",
      url: "/wallet/challenges",
      payload: {
        ecosystem: "polkadot",
        address: pair.address,
      },
    });
    expect(challengeRes.statusCode).toBe(200);
    const challengeBody = challengeRes.json<{ data: { challenge: { id: string; message: string } } }>();
    const challengeId = challengeBody.data.challenge.id;
    const message = challengeBody.data.challenge.message;

    const signatureHex = toHex(pair.sign(new TextEncoder().encode(message)));
    const sessionRes = await app.inject({
      method: "POST",
      url: "/wallet/sessions",
      payload: {
        challengeId,
        ecosystem: "polkadot",
        address: pair.address,
        signature: signatureHex,
      },
    });
    expect(sessionRes.statusCode).toBe(200);
    const sessionBody = sessionRes.json<{ data: { session: { token: string } } }>();
    const token = sessionBody.data.session.token;

    const getRes = await app.inject({
      method: "GET",
      url: "/wallet/session",
      headers: { "x-wallet-session": token },
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json<{ data: { session: { token: string } } }>();
    expect(getBody.data.session.token).toBe(token);

    const delRes = await app.inject({
      method: "DELETE",
      url: "/wallet/session",
      headers: { "x-wallet-session": token },
    });
    expect(delRes.statusCode).toBe(200);
    const delBody = delRes.json<{ data: { session: { revokedAt?: string } } }>();
    expect(typeof delBody.data.session.revokedAt).toBe("string");

    await app.close();
  });
});

function toHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
