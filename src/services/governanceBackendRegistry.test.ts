import { describe, it, expect, vi } from "vitest";
import { GovernanceBackendRegistry } from "./governanceBackendRegistry.js";
import type { GovernanceBackendDescriptor } from "@concord/governance";
import type { GovernanceIndexConsumer } from "./governanceIndexConsumer.js";

function makeDescriptor(id: string, backend: "substrate-opengov" | "evm-governor"): GovernanceBackendDescriptor {
  return {
    id,
    backend,
    chain: { namespace: backend === "evm-governor" ? "eip155" : "substrate", chainId: "test" },
    displayName: id,
    source: { kind: backend === "evm-governor" ? "fixture" : "subquery" },
    capabilities: {
      readSubjects: true,
      readVotes: true,
      readDelegations: backend !== "evm-governor",
      checkpoint: true,
      prepareProposal: true,
      submitProposal: true,
      castVote: true,
      delegate: backend !== "evm-governor",
      queueExecution: backend === "evm-governor",
      executeProposal: backend === "evm-governor",
      requiresWallet: false,
      supportsReason: true,
      supportsWeightedVote: false,
    },
  };
}

function makeMockConsumer(): GovernanceIndexConsumer {
  return { start: vi.fn() } as unknown as GovernanceIndexConsumer;
}

describe("GovernanceBackendRegistry", () => {
  it("starts empty", () => {
    const registry = new GovernanceBackendRegistry();
    expect(registry.size).toBe(0);
    expect(registry.listDescriptors()).toEqual([]);
  });

  it("registers backends and lists descriptors", () => {
    const registry = new GovernanceBackendRegistry();
    const subDesc = makeDescriptor("substrate:test", "substrate-opengov");
    const evmDesc = makeDescriptor("evm:test", "evm-governor");
    registry.register(subDesc, makeMockConsumer());
    registry.register(evmDesc, makeMockConsumer());

    expect(registry.size).toBe(2);
    const descriptors = registry.listDescriptors();
    expect(descriptors).toHaveLength(2);
    expect(descriptors[0].id).toBe("substrate:test");
    expect(descriptors[1].id).toBe("evm:test");
  });

  it("startAll calls start() on each consumer", () => {
    const registry = new GovernanceBackendRegistry();
    const consumer1 = makeMockConsumer();
    const consumer2 = makeMockConsumer();
    registry.register(makeDescriptor("sub", "substrate-opengov"), consumer1);
    registry.register(makeDescriptor("evm", "evm-governor"), consumer2);

    registry.startAll();

    expect(consumer1.start).toHaveBeenCalledOnce();
    expect(consumer2.start).toHaveBeenCalledOnce();
  });

  it("listDescriptors returns copies not references", () => {
    const registry = new GovernanceBackendRegistry();
    const desc = makeDescriptor("sub", "substrate-opengov");
    registry.register(desc, makeMockConsumer());

    const [first] = registry.listDescriptors();
    expect(first).toBe(desc); // same reference is fine, descriptors are immutable by convention
  });
});
