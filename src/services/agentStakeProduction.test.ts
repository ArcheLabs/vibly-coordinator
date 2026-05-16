import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createEvent } from "@concord/foundation";
import { ActionIntentDispatcher } from "../application/actionIntentDispatcher.js";
import { loadConfig } from "../config/env.js";
import type { AgentProfile } from "../contexts/identity/types.js";
import { startAgentStakeReleaseProcess } from "../process-managers/agentStakeReleaseProcess.js";
import { createInMemoryEventBus } from "./eventBus.js";
import { startAgentStakeIndexerSync } from "./agentStakeIndexerSync.js";
import type { ActionIntent, ActionIntentResult } from "../application/types.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import type { AgentStakeLedger } from "../contexts/stake/types.js";
import { StakeRepository } from "../contexts/stake/repository.js";

const stores: Array<{ close?: () => void }> = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close?.();
});

describe("agent stake production services", () => {
  it("syncs indexer ledgers into UpsertAgentStakeLedger intents and maps principalId from profiles", async () => {
    const store = makeStore();
    const profile: AgentProfile = {
      principalId: "agent-principal-1",
      displayName: "Agent 1",
      capabilities: ["math"],
      organizationIds: ["org-1"],
      chainId: "substrate:vibly-solo",
      identityId: "identity-1",
      chainAgentId: "chain-agent-1",
      dutyStatus: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.saveProjection("agent_profile_v2", profile.principalId, profile);

    const server = await startGraphqlFixture({
      data: {
        agentStakeLedgers: {
          nodes: [{
            id: "ledger-1",
            chainId: "substrate:vibly-solo",
            identityId: "identity-1",
            agentId: "chain-agent-1",
            fundingAccount: "5Funder",
            activeAmount: "1000",
            unbondingAmount: "0",
            status: "ACTIVE",
            unlockAtBlock: null,
            releaseBlocked: false,
            releaseBlockReason: null,
            updatedAtBlock: "42",
          }],
        },
      },
    });
    stores.push(server);

    const intents: ActionIntent[] = [];
    const dispatcher = new ActionIntentDispatcher();
    vi.spyOn(dispatcher, "dispatch").mockImplementation(async (intent): Promise<ActionIntentResult> => {
      intents.push(intent);
      return { eventId: "event-1", aggregateRef: { kind: "AgentStakeLedger", id: "ledger-1" }, status: "accepted", events: [] };
    });

    const stop = startAgentStakeIndexerSync({
      config: loadConfig({
        NODE_ENV: "test",
        API_AUTH_MODE: "none",
        SUBSTRATE_INDEXER_URL: server.url,
        AGENT_STAKE_SYNC_INTERVAL_MS: "10000",
      }),
      dispatcher,
      store,
      eventBus: createInMemoryEventBus(),
      concord: {} as never,
    });
    stores.push({ close: stop });

    await vi.waitFor(() => {
      expect(intents).toHaveLength(1);
    });
    await vi.waitFor(async () => {
      const health = await new StakeRepository(store).getIndexerHealth();
      expect(health).toMatchObject({ status: "healthy", consecutiveFailures: 0, ledgerCount: 1, sourceUrl: server.url });
    });
    expect(intents[0]).toMatchObject({
      type: "UpsertAgentStakeLedger",
      payload: {
        chainId: "substrate:vibly-solo",
        identityId: "identity-1",
        chainAgentId: "chain-agent-1",
        principalId: "agent-principal-1",
        status: "active",
        activeAmount: "1000",
      },
    });
  });

  it("paginates indexer ledgers beyond the first 500 rows", async () => {
    const store = makeStore();
    const ledgers = Array.from({ length: 501 }, (_, index) => ({
      id: `ledger-${index}`,
      chainId: "substrate:vibly-solo",
      identityId: `identity-${index}`,
      agentId: `chain-agent-${index}`,
      fundingAccount: null,
      activeAmount: "1000",
      unbondingAmount: "0",
      status: "ACTIVE",
      unlockAtBlock: null,
      releaseBlocked: false,
      releaseBlockReason: null,
      updatedAtBlock: String(index),
    }));
    const server = await startGraphqlFixture((request: GraphqlFixtureRequest) => {
      const offset = Number(request.variables?.offset ?? 0);
      const first = Number(request.variables?.first ?? 500);
      return { data: { agentStakeLedgers: { nodes: ledgers.slice(offset, offset + first) } } };
    });
    stores.push(server);

    const intents: ActionIntent[] = [];
    const dispatcher = new ActionIntentDispatcher();
    vi.spyOn(dispatcher, "dispatch").mockImplementation(async (intent): Promise<ActionIntentResult> => {
      intents.push(intent);
      return { eventId: "event-1", aggregateRef: { kind: "AgentStakeLedger", id: "ledger" }, status: "accepted", events: [] };
    });

    const stop = startAgentStakeIndexerSync({
      config: loadConfig({
        NODE_ENV: "test",
        API_AUTH_MODE: "none",
        SUBSTRATE_INDEXER_URL: server.url,
        AGENT_STAKE_SYNC_INTERVAL_MS: "10000",
      }),
      dispatcher,
      store,
      eventBus: createInMemoryEventBus(),
      concord: {} as never,
    });
    stores.push({ close: stop });

    await vi.waitFor(() => {
      expect(intents).toHaveLength(501);
    });
    const health = await new StakeRepository(store).getIndexerHealth();
    expect(health).toMatchObject({ status: "healthy", ledgerCount: 501 });
  });

  it("records indexer health failures without mutating existing ledgers", async () => {
    const store = makeStore();
    const ledger: AgentStakeLedger = {
      id: "substrate:vibly-solo:identity-1:chain-agent-1",
      chainId: "substrate:vibly-solo",
      identityId: "identity-1",
      chainAgentId: "chain-agent-1",
      principalId: "agent-principal-1",
      activeAmount: "1000",
      unbondingAmount: "0",
      status: "active",
      releaseBlocked: false,
      indexedAt: "2000-01-01T00:00:00.000Z",
    };
    await store.saveProjection("agent_stake_ledger_v1", ledger.id, ledger);
    const server = await startGraphqlFixture({ errors: [{ message: "indexer unavailable" }] });
    stores.push(server);

    const dispatcher = new ActionIntentDispatcher();
    vi.spyOn(dispatcher, "dispatch").mockImplementation(async (): Promise<ActionIntentResult> => {
      throw new Error("dispatch should not be called");
    });

    const stop = startAgentStakeIndexerSync({
      config: loadConfig({
        NODE_ENV: "test",
        API_AUTH_MODE: "none",
        SUBSTRATE_INDEXER_URL: server.url,
        AGENT_STAKE_SYNC_INTERVAL_MS: "10000",
      }),
      dispatcher,
      store,
      eventBus: createInMemoryEventBus(),
      concord: {} as never,
    });
    stores.push({ close: stop });

    await vi.waitFor(async () => {
      const health = await new StakeRepository(store).getIndexerHealth();
      expect(health).toMatchObject({ status: "degraded", consecutiveFailures: 1, ledgerCount: 0 });
    });
    await expect(store.getProjection<AgentStakeLedger>("agent_stake_ledger_v1", ledger.id)).resolves.toEqual(ledger);
  });

  it("submits idempotent block and clear commands for unbond release control", async () => {
    const store = makeStore();
    const eventBus = createInMemoryEventBus();
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "none",
      SUBSTRATE_STAKE_TX_MODE: "prepare-only",
    });
    startAgentStakeReleaseProcess(eventBus, store, config);

    const ledger: AgentStakeLedger = {
      id: "substrate:vibly-solo:identity-1:chain-agent-1",
      chainId: "substrate:vibly-solo",
      identityId: "identity-1",
      chainAgentId: "chain-agent-1",
      principalId: "agent-principal-1",
      activeAmount: "0",
      unbondingAmount: "1000",
      status: "unbonding",
      releaseBlocked: true,
      releaseBlockReason: "obligations:agent-principal-1",
      indexedAt: new Date().toISOString(),
    };

    eventBus.publish(createEvent({
      type: "AgentStakeReleaseBlockRequested",
      payload: ledger,
      actorId: config.coordinatorId as never,
    }));
    eventBus.publish(createEvent({
      type: "AgentStakeReleaseBlockRequested",
      payload: ledger,
      actorId: config.coordinatorId as never,
    }));

    await vi.waitFor(async () => {
      const command = await store.getProjection<{ receipt: { txHash: string } }>("agent_stake_chain_command_v1", `${ledger.id}:block`);
      expect(command?.receipt.txHash).toBe(`prepared:block_release:${ledger.id}`);
    });

    eventBus.publish(createEvent({
      type: "AgentStakeReleaseClearRequested",
      payload: ledger,
      actorId: config.coordinatorId as never,
    }));

    await vi.waitFor(async () => {
      const command = await store.getProjection<{ receipt: { txHash: string } }>("agent_stake_chain_command_v1", `${ledger.id}:clear`);
      expect(command?.receipt.txHash).toBe(`prepared:clear_release_block:${ledger.id}`);
    });
  });
});

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
    async tryAcquireLease() {
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

type GraphqlFixtureRequest = { variables?: Record<string, unknown> };

async function startGraphqlFixture(
  body: unknown | ((request: GraphqlFixtureRequest) => unknown),
): Promise<{ url: string; close: () => void }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const request = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as GraphqlFixtureRequest : {};
      const responseBody = typeof body === "function" ? body(request) : body;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind to a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/graphql`,
    close: () => server.close(),
  };
}
