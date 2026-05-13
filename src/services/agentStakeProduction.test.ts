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

async function startGraphqlFixture(body: unknown): Promise<{ url: string; close: () => void }> {
  const server: Server = createServer((_, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind to a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/graphql`,
    close: () => server.close(),
  };
}
