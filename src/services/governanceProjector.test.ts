import { describe, it, expect, beforeEach } from "vitest";
import { GovernanceProjectorService } from "./governanceProjector.js";
import type { NormalizedChainEvent } from "@vibly-ai/concord-core";
import type { GovernanceEventType, GovernanceProposalSummary } from "@vibly-ai/concord-governance";

const CHAIN = { namespace: "substrate", chainId: "vibly-solo" } as const;

function makeProposalEvent(
  type: GovernanceEventType,
  externalId: string,
  overrides?: Partial<GovernanceProposalSummary>,
): NormalizedChainEvent<GovernanceEventType> {
  const payload: GovernanceProposalSummary = {
    ref: { chain: CHAIN, backend: "substrate-opengov", externalId },
    title: `Proposal ${externalId}`,
    status: "Deciding",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T01:00:00Z",
    ...overrides,
  };
  return {
    id: `evt:${externalId}:${type}`,
    chain: CHAIN,
    type,
    payload,
    blockNumber: 100n,
    blockHash: "0xabc",
    observedAt: "2026-01-01T01:00:00Z",
    finality: "finalized",
  };
}

describe("GovernanceProjectorService", () => {
  let projector: GovernanceProjectorService;

  beforeEach(() => {
    projector = new GovernanceProjectorService();
  });

  it("GovernanceProposalDiscovered → subject patch with lifecycle.discoveredAt", () => {
    const event = makeProposalEvent("GovernanceProposalDiscovered", "42");
    const patches = projector.project(event);

    const subjectPatch = patches.find((p) => p.kind === "subject");
    expect(subjectPatch).toBeDefined();
    expect(subjectPatch?.kind).toBe("subject");
    if (subjectPatch?.kind === "subject") {
      expect(subjectPatch.value.externalId).toBe("42");
      expect(subjectPatch.value.lifecycle.discoveredAt).toBe("2026-01-01T01:00:00Z");
      expect(subjectPatch.value.finality).toBe("finalized");
    }
  });

  it("GovernanceProposalUpdated → subject patch with updated status", () => {
    const event = makeProposalEvent("GovernanceProposalUpdated", "42", { status: "Confirming" });
    const patches = projector.project(event);

    const subjectPatch = patches.find((p) => p.kind === "subject");
    expect(subjectPatch?.kind).toBe("subject");
    if (subjectPatch?.kind === "subject") {
      expect(subjectPatch.value.status).toBe("Confirming");
    }
  });

  it("every valid event also produces a checkpoint patch", () => {
    const event = makeProposalEvent("GovernanceProposalDiscovered", "42");
    const patches = projector.project(event);

    const checkpointPatch = patches.find((p) => p.kind === "checkpoint");
    expect(checkpointPatch).toBeDefined();
    if (checkpointPatch?.kind === "checkpoint") {
      expect(checkpointPatch.value.chain).toEqual(CHAIN);
      expect(checkpointPatch.value.finalized).toBe(true);
    }
  });

  it("GovernanceVoteCast → vote patch with stance, conviction, balance", () => {
    const payload = {
      ref: { chain: CHAIN, backend: "substrate-opengov" as const, externalId: "42" },
      status: "Deciding",
      voter: "0xVoter",
      stance: "aye",
      conviction: "Locked1x",
      balance: "500000000",
    };
    const event: NormalizedChainEvent<GovernanceEventType> = {
      id: "evt:vote:42",
      chain: CHAIN,
      type: "GovernanceVoteCast",
      payload,
      blockNumber: 101n,
      observedAt: "2026-01-01T02:00:00Z",
      finality: "finalized",
    };
    const patches = projector.project(event);

    const votePatch = patches.find((p) => p.kind === "vote");
    expect(votePatch).toBeDefined();
    if (votePatch?.kind === "vote") {
      expect(votePatch.value.voter).toBe("0xVoter");
      expect(votePatch.value.stance).toBe("aye");
      expect(votePatch.value.conviction).toBe("Locked1x");
      expect(votePatch.value.balance).toBe("500000000");
    }
  });

  it("GovernanceDelegated → delegation patch with isActive=true", () => {
    const payload = {
      ref: { chain: CHAIN, backend: "substrate-opengov" as const, externalId: "0xDelegator" },
      status: "active",
      delegatee: "0xDelegatee",
      scope: "class:10",
      conviction: "Locked2x",
    };
    const event: NormalizedChainEvent<GovernanceEventType> = {
      id: "evt:delegation:delegated",
      chain: CHAIN,
      type: "GovernanceDelegated",
      payload,
      blockNumber: 102n,
      observedAt: "2026-01-01T03:00:00Z",
      finality: "finalized",
    };
    const patches = projector.project(event);

    const delegationPatch = patches.find((p) => p.kind === "delegation");
    expect(delegationPatch).toBeDefined();
    if (delegationPatch?.kind === "delegation") {
      expect(delegationPatch.value.isActive).toBe(true);
      expect(delegationPatch.value.delegatee).toBe("0xDelegatee");
      expect(delegationPatch.value.conviction).toBe("Locked2x");
    }
  });

  it("GovernanceUndelegated → delegation patch with isActive=false", () => {
    const payload = {
      ref: { chain: CHAIN, backend: "substrate-opengov" as const, externalId: "0xDelegator" },
      status: "inactive",
      scope: "class:10",
    };
    const event: NormalizedChainEvent<GovernanceEventType> = {
      id: "evt:delegation:undelegated",
      chain: CHAIN,
      type: "GovernanceUndelegated",
      payload,
      blockNumber: 103n,
      observedAt: "2026-01-01T04:00:00Z",
      finality: "finalized",
    };
    const patches = projector.project(event);

    const delegationPatch = patches.find((p) => p.kind === "delegation");
    expect(delegationPatch).toBeDefined();
    if (delegationPatch?.kind === "delegation") {
      expect(delegationPatch.value.isActive).toBe(false);
    }
  });

  it("unknown event type returns empty array (no throw)", () => {
    const event: NormalizedChainEvent<GovernanceEventType> = {
      id: "evt:unknown",
      chain: CHAIN,
      type: "GovernanceFinalityUpdated",
      payload: undefined,
      observedAt: "2026-01-01T05:00:00Z",
      finality: "finalized",
    };
    // GovernanceFinalityUpdated with no valid proposal ref → []
    const patches = projector.project(event);
    expect(patches).toEqual([]);
  });

  it("event with missing externalId returns empty array (no throw)", () => {
    const event: NormalizedChainEvent<GovernanceEventType> = {
      id: "evt:bad",
      chain: CHAIN,
      type: "GovernanceProposalDiscovered",
      payload: { ref: { chain: CHAIN, backend: "substrate-opengov" }, status: "Submitted" },
      observedAt: "2026-01-01T05:00:00Z",
      finality: "finalized",
    };
    const patches = projector.project(event);
    expect(patches).toEqual([]);
  });

  it("replaying the same event produces same deterministic ids (idempotent)", () => {
    const event = makeProposalEvent("GovernanceProposalDiscovered", "42");
    const patches1 = projector.project(event);
    const patches2 = projector.project(event);

    const subjectId1 = patches1.find((p) => p.kind === "subject")?.id;
    const subjectId2 = patches2.find((p) => p.kind === "subject")?.id;
    expect(subjectId1).toBe(subjectId2);
    expect(subjectId1).toBe("substrate:vibly-solo:42");
  });
});
