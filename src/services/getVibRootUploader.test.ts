import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/env.js";
import type { CoordinatorStorePort, CreateLeaseInput, Lease } from "../db/coordinatorStorePort.js";
import { GET_VIB_ALLOCATION, GET_VIB_MANIFEST } from "../modules/identity/onboarding/domain.js";
import {
  buildAndSaveManifest,
  GET_VIB_ROOT_UPLOAD,
  getRootUploadRecord,
  ingestFinalizedDeposit,
  type AllocationRecord,
  type RootUploadRecord,
} from "../modules/conversion/get-vib/domain.js";
import { runGetVibRootUploadTick } from "./getVibRootUploader.js";
import type { GetVibRootReceipt } from "./getVibRootChainActions.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111111111111111111111111111";

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    COORDINATOR_ID: "coordinator-test",
    SUBSTRATE_CHAIN_ID: "local:get-vib-test",
    VIBLY_DOT_RECEIVING_ADDRESS: "deposit",
    GET_VIB_ROOT_UPLOAD_INTERVAL_MS: "1000",
    GET_VIB_ROOT_UPLOAD_MODE: "fixture",
    ...overrides,
  });
}

describe("Get VIB root uploader", () => {
  it("does nothing when no confirmed allocation exists", async () => {
    const store = makeStore();
    const actions = { submitClaimRoot: vi.fn() };

    await expect(runGetVibRootUploadTick({ config: config(), store, actions })).resolves.toBeUndefined();

    expect(actions.submitClaimRoot).not.toHaveBeenCalled();
    expect(await store.listProjections(GET_VIB_MANIFEST)).toHaveLength(0);
  });

  it("builds a manifest, uploads the root, and records the receipt", async () => {
    const store = makeStore();
    const cfg = config();
    await addConfirmedAllocation(store, cfg);
    const actions = { submitClaimRoot: vi.fn(async (): Promise<GetVibRootReceipt> => ({ txHash: "0xroot", mode: "fixture", finality: "included" })) };

    const upload = await runGetVibRootUploadTick({ config: cfg, store, actions });

    expect(actions.submitClaimRoot).toHaveBeenCalledTimes(1);
    expect(upload).toMatchObject({ status: "uploaded", txHash: "0xroot", rootVersion: 1, mode: "fixture" });
    expect(await store.listProjections(GET_VIB_MANIFEST)).toHaveLength(1);
    const allocations = await store.listProjections<AllocationRecord>(GET_VIB_ALLOCATION);
    expect(allocations[0]).toMatchObject({ status: "root_included", rootVersion: 1 });
  });

  it("does not re-upload an already uploaded root", async () => {
    const store = makeStore();
    const cfg = config();
    await addConfirmedAllocation(store, cfg);
    const actions = { submitClaimRoot: vi.fn(async (): Promise<GetVibRootReceipt> => ({ txHash: "0xroot", mode: "fixture", finality: "included" })) };

    await runGetVibRootUploadTick({ config: cfg, store, actions });
    await runGetVibRootUploadTick({ config: cfg, store, actions });

    expect(actions.submitClaimRoot).toHaveBeenCalledTimes(1);
  });

  it("uploads an existing manifest before building another one", async () => {
    const store = makeStore();
    const cfg = config();
    await addConfirmedAllocation(store, cfg);
    const manifest = await buildAndSaveManifest(store, cfg);
    const actions = { submitClaimRoot: vi.fn(async (): Promise<GetVibRootReceipt> => ({ txHash: "0xroot", mode: "fixture", finality: "included" })) };

    const upload = await runGetVibRootUploadTick({ config: cfg, store, actions });

    expect(upload?.rootVersion).toBe(manifest.rootVersion);
    expect(await store.listProjections(GET_VIB_MANIFEST)).toHaveLength(1);
  });

  it("skips when another coordinator holds the lease", async () => {
    const store = makeStore({ denyRootUploadLease: true });
    const cfg = config();
    await addConfirmedAllocation(store, cfg);
    const actions = { submitClaimRoot: vi.fn() };

    await expect(runGetVibRootUploadTick({ config: cfg, store, actions })).resolves.toBeUndefined();

    expect(actions.submitClaimRoot).not.toHaveBeenCalled();
  });

  it("records failures and retries the same manifest on the next tick", async () => {
    const store = makeStore();
    const cfg = config();
    await addConfirmedAllocation(store, cfg);
    const submitClaimRoot = vi.fn();
    submitClaimRoot.mockRejectedValueOnce(new Error("chain unavailable"));
    submitClaimRoot.mockResolvedValueOnce({ txHash: "0xroot", mode: "fixture", finality: "included" } satisfies GetVibRootReceipt);
    const actions = { submitClaimRoot };

    const failed = await runGetVibRootUploadTick({ config: cfg, store, actions });
    const uploaded = await runGetVibRootUploadTick({ config: cfg, store, actions });

    expect(failed).toMatchObject({ status: "failed", lastError: "chain unavailable" });
    expect(uploaded).toMatchObject({ status: "uploaded", txHash: "0xroot", rootVersion: 1 });
    expect(actions.submitClaimRoot).toHaveBeenCalledTimes(2);
    await expect(getRootUploadRecord(store, cfg.substrateChainId, 1)).resolves.toMatchObject({ status: "uploaded" });
  });

  it("treats prepare-only receipts as complete only while still in prepare-only mode", async () => {
    const store = makeStore();
    const prepareConfig = config({ GET_VIB_ROOT_UPLOAD_MODE: "prepare-only" });
    await addConfirmedAllocation(store, prepareConfig);
    const actions = { submitClaimRoot: vi.fn(async (): Promise<GetVibRootReceipt> => ({ txHash: "prepared", mode: "prepare-only", finality: "prepared" })) };

    await runGetVibRootUploadTick({ config: prepareConfig, store, actions });
    await runGetVibRootUploadTick({ config: prepareConfig, store, actions });

    expect(actions.submitClaimRoot).toHaveBeenCalledTimes(1);
    const records = await store.listProjections<RootUploadRecord>(GET_VIB_ROOT_UPLOAD);
    expect(records[0]).toMatchObject({ status: "prepared", mode: "prepare-only" });
  });
});

async function addConfirmedAllocation(store: CoordinatorStorePort, cfg: ReturnType<typeof config>) {
  await ingestFinalizedDeposit({
    store,
    config: cfg,
    sourceId: `source-${Math.random()}`,
    dotAmount: "1",
    accountId: ACCOUNT,
    paymentId: `payment-${Math.random()}`,
    finalizedAt: "2026-06-01T00:00:00.000Z",
  });
}

function makeStore(opts: { denyRootUploadLease?: boolean } = {}): CoordinatorStorePort {
  const projections = new Map<string, Map<string, unknown>>();
  const leases = new Map<string, Lease>();
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
    async createLease(input: CreateLeaseInput) {
      const lease = makeLease(input);
      leases.set(lease.id, lease);
      return lease;
    },
    async tryAcquireLease(input: CreateLeaseInput) {
      if (opts.denyRootUploadLease && input.kind === "get-vib-root-uploader") return undefined;
      const active = Array.from(leases.values()).find(
        (lease) => lease.kind === input.kind && lease.resourceId === input.resourceId && new Date(lease.expiresAt).getTime() > Date.now(),
      );
      if (active) return undefined;
      const lease = makeLease(input);
      leases.set(lease.id, lease);
      return lease;
    },
    async getLease(id: string) {
      return leases.get(id);
    },
    async getActiveLease(kind: string, resourceId: string) {
      return Array.from(leases.values()).find((lease) => lease.kind === kind && lease.resourceId === resourceId && new Date(lease.expiresAt).getTime() > Date.now());
    },
    async renewLease(id: string, ttlMs: number) {
      const lease = leases.get(id);
      if (!lease) return undefined;
      const renewed = { ...lease, expiresAt: new Date(Date.now() + ttlMs).toISOString(), renewedAt: new Date().toISOString() };
      leases.set(id, renewed);
      return renewed;
    },
    async releaseLease(id: string) {
      leases.delete(id);
    },
    async sweepExpiredLeases() {
      return [];
    },
  };
}

function makeLease(input: CreateLeaseInput): Lease {
  return {
    id: `lease-${Math.random().toString(16).slice(2)}`,
    kind: input.kind,
    resourceId: input.resourceId,
    holderId: input.holderId,
    expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
    createdAt: new Date().toISOString(),
  };
}
