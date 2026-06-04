import type { CoordinatorConfig } from "../config/env.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import {
  buildAndSaveManifest,
  getLatestManifest,
  getNetworkId,
  getRootUploadRecord,
  hasConfirmedGetVibAllocations,
  listRootUploadRecords,
  saveRootUploadRecord,
  type AllocationManifest,
  type RootUploadRecord,
} from "../modules/conversion/get-vib/domain.js";
import { GetVibRootChainActions } from "./getVibRootChainActions.js";
import type { GetVibRootReceipt } from "./getVibRootChainActions.js";

const LEASE_KIND = "get-vib-root-uploader";

export function startGetVibRootUploader(input: {
  config: CoordinatorConfig;
  store: CoordinatorStorePort;
  actions?: Pick<GetVibRootChainActions, "submitClaimRoot">;
}): () => void {
  if (input.config.getVibRootUploadIntervalMs <= 0) return () => {};
  if (!input.config.getVibClaimEnabled) return () => {};

  const actions = input.actions ?? new GetVibRootChainActions(input.config);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runGetVibRootUploadTick({ ...input, actions });
    } catch (err) {
      console.error("[GetVibRootUploader]", err);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => { void tick(); }, input.config.getVibRootUploadIntervalMs);
  return () => clearInterval(timer);
}

export async function runGetVibRootUploadTick(input: {
  config: CoordinatorConfig;
  store: CoordinatorStorePort;
  actions?: Pick<GetVibRootChainActions, "submitClaimRoot">;
}): Promise<RootUploadRecord | undefined> {
  if (input.config.getVibRootUploadIntervalMs <= 0) return undefined;
  if (!input.config.getVibClaimEnabled) return undefined;
  const leaseStore = input.store as CoordinatorStorePort & { tryAcquireLease?: CoordinatorStorePort["tryAcquireLease"] };
  if (typeof leaseStore.tryAcquireLease !== "function") return undefined;
  const networkId = getNetworkId(input.config);
  const lease = await leaseStore.tryAcquireLease({
    kind: LEASE_KIND,
    resourceId: networkId,
    holderId: input.config.coordinatorId,
    ttlMs: Math.max(input.config.getVibRootUploadIntervalMs, 60_000),
  });
  if (!lease) return undefined;

  try {
    const manifest = await selectManifest(input.store, input.config);
    if (!manifest) return undefined;
    return await uploadManifest({
      store: input.store,
      config: input.config,
      actions: input.actions ?? new GetVibRootChainActions(input.config),
      manifest,
    });
  } finally {
    await input.store.releaseLease(lease.id);
  }
}

export async function getGetVibRootUploaderStatus(input: {
  config: CoordinatorConfig;
  store: CoordinatorStorePort;
}): Promise<{
  enabled: boolean;
  intervalMs: number;
  mode: CoordinatorConfig["getVibRootUploadMode"];
  networkId: string;
  latestManifest?: AllocationManifest;
  latestUpload?: RootUploadRecord;
}> {
  const [latestManifest, uploads] = await Promise.all([
    getLatestManifest(input.store, input.config),
    listRootUploadRecords(input.store, input.config),
  ]);
  return {
    enabled: input.config.getVibClaimEnabled && input.config.getVibRootUploadIntervalMs > 0,
    intervalMs: input.config.getVibRootUploadIntervalMs,
    mode: input.config.getVibRootUploadMode,
    networkId: getNetworkId(input.config),
    latestManifest,
    latestUpload: uploads[0],
  };
}

async function selectManifest(store: CoordinatorStorePort, config: CoordinatorConfig): Promise<AllocationManifest | undefined> {
  const latest = await getLatestManifest(store, config);
  if (latest) {
    const upload = await getRootUploadRecord(store, latest.networkId, latest.rootVersion);
    if (!isUploadComplete(upload, config.getVibRootUploadMode)) return latest;
  }

  if (!(await hasConfirmedGetVibAllocations(store, config))) return undefined;
  return buildAndSaveManifest(store, config);
}

function isUploadComplete(record: RootUploadRecord | undefined, mode: CoordinatorConfig["getVibRootUploadMode"]): boolean {
  if (!record) return false;
  if (record.status === "uploaded") return true;
  return mode === "prepare-only" && record.mode === "prepare-only" && record.status === "prepared";
}

async function uploadManifest(input: {
  store: CoordinatorStorePort;
  config: CoordinatorConfig;
  actions: Pick<GetVibRootChainActions, "submitClaimRoot">;
  manifest: AllocationManifest;
}): Promise<RootUploadRecord> {
  const attemptedAt = new Date().toISOString();
  try {
    const receipt = await input.actions.submitClaimRoot(input.manifest);
    return saveRootUploadRecord(input.store, recordFromReceipt(input.manifest, receipt, attemptedAt));
  } catch (err) {
    return saveRootUploadRecord(input.store, {
      networkId: input.manifest.networkId,
      rootVersion: input.manifest.rootVersion,
      merkleRoot: input.manifest.merkleRoot,
      metadataHash: input.manifest.metadataHash,
      totalCumulativeAmount: input.manifest.totalCumulativeAmount,
      status: "failed",
      mode: input.config.getVibRootUploadMode,
      attemptedAt,
      lastError: err instanceof Error ? err.message : String(err),
    });
  }
}

function recordFromReceipt(manifest: AllocationManifest, receipt: GetVibRootReceipt, attemptedAt: string): Omit<RootUploadRecord, "id"> {
  const uploaded = receipt.finality !== "prepared";
  return {
    networkId: manifest.networkId,
    rootVersion: manifest.rootVersion,
    merkleRoot: manifest.merkleRoot,
    metadataHash: manifest.metadataHash,
    totalCumulativeAmount: manifest.totalCumulativeAmount,
    status: uploaded ? "uploaded" : "prepared",
    mode: receipt.mode,
    finality: receipt.finality,
    txHash: receipt.txHash,
    attemptedAt,
    uploadedAt: uploaded ? attemptedAt : undefined,
  };
}
