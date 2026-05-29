import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../config/env.js";
import type { CoordinatorStorePort } from "../../../db/coordinatorStorePort.js";
import {
  buildRelayDepositSourceId,
  decimalFromBaseUnits,
  getAllocationSummary,
  getRecords,
  ingestFinalizedDeposit,
  listObservedRelayDeposits,
  markObservedRelayDepositFailed,
  quoteGetVibAmount,
  saveObservedRelayDeposit,
} from "./domain.js";
import {
  DEFAULT_CURVE_CONFIG,
  getPurchasePhase,
  priceAtSold,
  quoteBuyVib,
  validatePurchase,
} from "./vibCurve.js";

function makeStore(): CoordinatorStorePort {
  const projections = new Map<string, Map<string, unknown>>();
  const leases = new Map<string, { id: string; kind: string; resourceId: string; holderId: string; expiresAt: string; createdAt: string; renewedAt?: string }>();
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
      const id = `lease_${leases.size + 1}`;
      const now = new Date().toISOString();
      const lease = { id, kind: "test", resourceId: "test", holderId: "test", expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: now };
      leases.set(id, lease);
      return lease;
    },
    async tryAcquireLease(input) {
      const active = Array.from(leases.values()).find((lease) => lease.kind === input.kind && lease.resourceId === input.resourceId && new Date(lease.expiresAt).getTime() > Date.now());
      if (active) return undefined;
      const id = `lease_${leases.size + 1}`;
      const now = new Date().toISOString();
      const lease = { id, kind: input.kind, resourceId: input.resourceId, holderId: input.holderId, expiresAt: new Date(Date.now() + input.ttlMs).toISOString(), createdAt: now };
      leases.set(id, lease);
      return lease;
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
    async releaseLease(id) {
      leases.delete(id);
    },
    async sweepExpiredLeases() {
      return [];
    },
  };
}

describe("Get VIB relay deposits", () => {
  it("matches the capped launch curve price checkpoints", () => {
    expect(priceAtSold(0n)).toBeCloseTo(0.01, 6);
    expect(priceAtSold(10_000_000n)).toBeCloseTo(0.013207, 6);
    expect(priceAtSold(20_000_000n)).toBeCloseTo(0.017942, 6);
    expect(priceAtSold(30_000_000n)).toBeCloseTo(0.024882, 6);
    expect(priceAtSold(40_000_000n)).toBeCloseTo(0.035053, 6);
    expect(priceAtSold(50_000_000n)).toBeCloseTo(0.05, 6);
  });

  it("enforces curve allocation boundaries", () => {
    expect(() => quoteBuyVib(49_999_000n, 1_000n)).not.toThrow();
    expect(() => quoteBuyVib(49_999_000n, 2_000n)).toThrow("VIB curve allocation exceeded");
    expect(() => quoteBuyVib(50_000_000n, 1n)).toThrow("VIB curve allocation exceeded");
  });

  it("enforces phase account limits", () => {
    expect(getPurchasePhase(0n)).toBe(1);
    expect(getPurchasePhase(10_000_000n)).toBe(2);
    expect(getPurchasePhase(30_000_000n)).toBe(3);
    expect(() =>
      validatePurchase({ soldBefore: 0n, vibAmount: 100_001n, accountPurchasedTotal: 0n, costUsd: 1200, config: DEFAULT_CURVE_CONFIG }),
    ).toThrow("VIB account phase limit exceeded");
    expect(() =>
      validatePurchase({ soldBefore: 10_000_000n, vibAmount: 500_001n, accountPurchasedTotal: 0n, costUsd: 7000, config: DEFAULT_CURVE_CONFIG }),
    ).toThrow("VIB account phase limit exceeded");
    expect(() =>
      validatePurchase({ soldBefore: 30_000_000n, vibAmount: 1_000_000n, accountPurchasedTotal: 1_000_001n, costUsd: 8000, config: DEFAULT_CURVE_CONFIG }),
    ).toThrow("VIB account phase limit exceeded");
  });

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
    expect(result.allocation.vibAmount).toBe("1097");
    expect(summary.purchasedAllocation).toBe("1097");
    expect(relayDeposits[0]).toMatchObject({
      id: observed.deposit.id,
      status: "confirmed",
      confirmedDepositId: result.deposit.id,
      allocationId: result.allocation.id,
    });
  });

  it("quotes direct wallet transfers without per-transaction purchase caps", async () => {
    const store = makeStore();
    const config = loadConfig({
      NODE_ENV: "test",
      SUBSTRATE_CHAIN_ID: "local:get-vib-test",
      VIBLY_DOT_RECEIVING_ADDRESS: "deposit",
      VIBLY_GET_VIB_DOT_USD_PRICE: "10",
    });

    await expect(quoteGetVibAmount(store, config, "1500")).resolves.toMatchObject({
      dotAmount: "1500",
      paymentAmount: "1500",
    });
  });

  it("exposes observed relay deposits in account records", async () => {
    const store = makeStore();
    const config = loadConfig({
      NODE_ENV: "test",
      SUBSTRATE_CHAIN_ID: "local:get-vib-test",
      VIBLY_DOT_RECEIVING_ADDRESS: "deposit",
      VIBLY_GET_VIB_RELAY_CHAIN_ID: "polkadot-dev",
    });
    const accountId = "0x1111111111111111111111111111111111111111111111111111111111111111";
    await saveObservedRelayDeposit(store, {
      relayChainId: "polkadot-dev",
      sourceId: "polkadot-dev:0xabc:0:1",
      from: accountId,
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

    const records = await getRecords(store, config, accountId);
    expect(records.relayDeposits).toHaveLength(1);
    expect(records.relayDeposits[0]).toMatchObject({
      sourceId: "polkadot-dev:0xabc:0:1",
      from: accountId,
      status: "observed",
      extrinsicHash: "0xtx",
    });
  });

  it("marks observed relay deposits failed with an account fallback", async () => {
    const store = makeStore();
    const accountId = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const observed = await saveObservedRelayDeposit(store, {
      relayChainId: "polkadot-dev",
      sourceId: "polkadot-dev:0xabc:0:1",
      from: accountId,
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

    const failed = await markObservedRelayDepositFailed(store, observed.deposit, "allocation failed");
    expect(failed).toMatchObject({
      status: "failed",
      accountId,
      failureReason: "allocation failed",
    });
  });
});
