import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env.js";
import type { CoordinatorStorePort } from "../../../db/coordinatorStorePort.js";
import {
  buildRelayDepositSourceId,
  decimalFromBaseUnits,
  getAllocationSummary,
  ingestFinalizedDeposit,
  listObservedRelayDeposits,
  saveObservedRelayDeposit,
} from "./domain.js";

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

describe("Get VIB relay deposits", () => {
  it("builds stable source IDs and converts relay base units", () => {
    expect(buildRelayDepositSourceId({
      relayChainId: "polkadot-dev",
      blockHash: "0xabc",
      extrinsicIndex: 2,
      eventIndex: 4,
    })).toBe("polkadot-dev:0xabc:2:4");
    expect(decimalFromBaseUnits("10000000000", 10)).toBe("1");
    expect(decimalFromBaseUnits("12500000000", 10)).toBe("1.25");
  });

  it("persists observed relay deposits idempotently", async () => {
    const store = makeStore();
    const sourceId = "polkadot-dev:0xabc:0:1";
    const first = await saveObservedRelayDeposit(store, {
      relayChainId: "polkadot-dev",
      sourceId,
      from: "from",
      to: "to",
      amountBaseUnits: "10000000000",
      dotAmount: "1",
      blockNumber: 1,
      blockHash: "0xabc",
      extrinsicIndex: 0,
      eventIndex: 1,
      extrinsicHash: "0xtx",
      finalizedAt: "2026-05-24T00:00:00.000Z",
    });
    const second = await saveObservedRelayDeposit(store, {
      relayChainId: "polkadot-dev",
      sourceId,
      from: "from",
      to: "to",
      amountBaseUnits: "10000000000",
      dotAmount: "1",
      blockNumber: 1,
      blockHash: "0xabc",
      extrinsicIndex: 0,
      eventIndex: 1,
      finalizedAt: "2026-05-24T00:00:00.000Z",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await listObservedRelayDeposits(store)).toHaveLength(1);
  });

  it("finalizes an observed relay deposit into a confirmed allocation", async () => {
    const store = makeStore();
    const config = loadConfig({
      NODE_ENV: "test",
      SUBSTRATE_CHAIN_ID: "local:get-vib-test",
      VIBLY_DOT_RECEIVING_ADDRESS: "deposit",
      VIBLY_CONVERSION_INITIAL_RATE: "1000",
    });
    const observed = await saveObservedRelayDeposit(store, {
      relayChainId: "polkadot-dev",
      sourceId: "polkadot-dev:0xabc:0:1",
      from: "from",
      to: "deposit",
      amountBaseUnits: "10000000000",
      dotAmount: "1",
      blockNumber: 1,
      blockHash: "0xabc",
      extrinsicIndex: 0,
      eventIndex: 1,
      extrinsicHash: "0xtx",
      finalizedAt: "2026-05-24T00:00:00.000Z",
    });

    const result = await ingestFinalizedDeposit({
      store,
      config,
      observedDepositId: observed.deposit.id,
      accountId: "0x1111111111111111111111111111111111111111111111111111111111111111",
    });
    const summary = await getAllocationSummary(store, config, result.deposit.accountId);
    const relayDeposits = await listObservedRelayDeposits(store, { status: "confirmed" });

    expect(result.deposit.sourceId).toBe(observed.deposit.sourceId);
    expect(result.deposit.paymentId).toBe("0xtx");
    expect(result.allocation.vibAmount).toBe("1000");
    expect(summary.purchasedAllocation).toBe("1000");
    expect(relayDeposits[0]).toMatchObject({
      id: observed.deposit.id,
      status: "confirmed",
      confirmedDepositId: result.deposit.id,
      allocationId: result.allocation.id,
    });
  });
});
