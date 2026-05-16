import { describe, expect, it } from "vitest";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import type { AgentProfile } from "../contexts/identity/types.js";
import type { AgentStakeLedger } from "../contexts/stake/types.js";
import { StakeRepository } from "../contexts/stake/repository.js";
import { filterEligibleAgents } from "./agentEligibility.js";

describe("filterEligibleAgents", () => {
  it("keeps active stake eligible even when indexedAt is stale", async () => {
    const store = makeStore();
    const agent = makeAgent("agent-1");
    await saveLedger(store, agent, {
      status: "active",
      activeAmount: "100",
      releaseBlocked: false,
      indexedAt: "2000-01-01T00:00:00.000Z",
    });

    await expect(filterEligibleAgents(store, [agent], { minStake: "50" })).resolves.toEqual([agent]);
  });

  it("fails closed for missing, inactive, blocked, and underfunded stake", async () => {
    const store = makeStore();
    const missing = makeAgent("missing");
    const inactive = makeAgent("inactive");
    const blocked = makeAgent("blocked");
    const underfunded = makeAgent("underfunded");
    await saveLedger(store, inactive, { status: "unbonding", activeAmount: "100", releaseBlocked: false });
    await saveLedger(store, blocked, { status: "active", activeAmount: "100", releaseBlocked: true });
    await saveLedger(store, underfunded, { status: "active", activeAmount: "10", releaseBlocked: false });

    await expect(filterEligibleAgents(store, [missing, inactive, blocked, underfunded], { minStake: "50" })).resolves.toEqual([]);
  });
});

function makeAgent(principalId: string): AgentProfile {
  return {
    principalId,
    displayName: principalId,
    capabilities: [],
    organizationIds: ["org-1"],
    reputationScore: 0.7,
    chainId: "substrate:vibly-solo",
    identityId: `identity-${principalId}`,
    chainAgentId: `chain-${principalId}`,
    dutyStatus: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function saveLedger(
  store: CoordinatorStorePort,
  agent: AgentProfile,
  patch: Pick<AgentStakeLedger, "status" | "activeAmount" | "releaseBlocked"> & Partial<AgentStakeLedger>,
): Promise<void> {
  await new StakeRepository(store).saveLedger({
    id: `${agent.chainId}:${agent.identityId}:${agent.chainAgentId}`,
    chainId: agent.chainId!,
    identityId: agent.identityId!,
    chainAgentId: agent.chainAgentId!,
    principalId: agent.principalId,
    activeAmount: patch.activeAmount,
    unbondingAmount: patch.unbondingAmount ?? "0",
    status: patch.status,
    releaseBlocked: patch.releaseBlocked,
    indexedAt: patch.indexedAt ?? new Date().toISOString(),
  });
}

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
