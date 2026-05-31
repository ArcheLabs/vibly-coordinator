import { ApiPromise, WsProvider } from "@polkadot/api";
import { decodeAddress } from "@polkadot/util-crypto";
import { createEvent } from "@concord/foundation";
import type { CoordinatorConfig } from "../config/env.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import type { EventBus } from "../services/eventBus.js";
import {
  buildRelayDepositSourceId,
  decimalFromBaseUnits,
  getNetworkId,
  getRelayWatcherState,
  ingestFinalizedDeposit,
  markObservedRelayDepositFailed,
  saveObservedRelayDeposit,
  saveRelayWatcherState,
} from "../modules/conversion/get-vib/domain.js";

type TransferData = {
  from: string;
  to: string;
  amountBaseUnits: string;
};

type EventRecordLike = {
  phase?: unknown;
  event?: {
    section?: string;
    method?: string;
    data?: unknown;
  };
};

type SignedBlockLike = {
  block: {
    extrinsics: Array<{ hash?: { toHex(): string } }>;
  };
};

const LEASE_KIND = "get-vib-relay-deposit-watcher";

export function startGetVibRelayDepositWatcher(input: {
  config: CoordinatorConfig;
  store: CoordinatorStorePort;
  eventBus?: EventBus;
}): () => void {
  if (
    !input.config.getVibRelayRpcUrl ||
    !input.config.viblyDotReceivingAddress ||
    input.config.getVibDepositScanIntervalMs <= 0
  ) {
    return () => {};
  }

  let api: ApiPromise | undefined;
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    let leaseId: string | undefined;
    try {
      const lease = await input.store.tryAcquireLease({
        kind: LEASE_KIND,
        resourceId: input.config.getVibRelayChainId,
        holderId: input.config.coordinatorId,
        ttlMs: Math.max(input.config.getVibDepositScanIntervalMs * 3, 30_000),
      });
      if (!lease) return;
      leaseId = lease.id;

      api ??= await ApiPromise.create({ provider: new WsProvider(input.config.getVibRelayRpcUrl) });
      await scanRelayDeposits({ ...input, api });
    } catch (err) {
      await recordWatcherError(input.store, input.config, err);
      console.error("[GetVibRelayDepositWatcher]", err);
    } finally {
      if (leaseId) await input.store.releaseLease(leaseId).catch(() => {});
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => { void tick(); }, input.config.getVibDepositScanIntervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    void api?.disconnect();
  };
}

async function scanRelayDeposits(input: {
  config: CoordinatorConfig;
  store: CoordinatorStorePort;
  api: ApiPromise;
  eventBus?: EventBus;
}): Promise<void> {
  const finalizedHash = await input.api.rpc.chain.getFinalizedHead();
  const finalizedHeader = await input.api.rpc.chain.getHeader(finalizedHash);
  const finalizedBlock = Number(finalizedHeader.number.toString());
  const targetBlock = Math.max(0, finalizedBlock - input.config.getVibDepositFinalityBlocks);
  const previous = await getRelayWatcherState(input.store, input.config.getVibRelayChainId);
  const startBlock = Math.max(
    input.config.getVibDepositStartBlock,
    (previous?.lastProcessedBlock ?? input.config.getVibDepositStartBlock - 1) + 1,
  );
  let observedCount = 0;
  let lastProcessedBlock = previous?.lastProcessedBlock;

  for (let blockNumber = startBlock; blockNumber <= targetBlock; blockNumber += 1) {
    observedCount += await scanBlock(input, blockNumber);
    lastProcessedBlock = blockNumber;
  }

  const now = new Date().toISOString();
  await saveRelayWatcherState(input.store, {
    relayChainId: input.config.getVibRelayChainId,
    status: "healthy",
    sourceUrl: input.config.getVibRelayRpcUrl,
    depositAddress: input.config.viblyDotReceivingAddress,
    lastProcessedBlock,
    lastFinalizedBlock: finalizedBlock,
    lastAttemptAt: now,
    lastSuccessfulScanAt: now,
    observedCount: (previous?.observedCount ?? 0) + observedCount,
  });
}

async function scanBlock(input: {
  config: CoordinatorConfig;
  store: CoordinatorStorePort;
  api: ApiPromise;
  eventBus?: EventBus;
}, blockNumber: number): Promise<number> {
  const hash = await input.api.rpc.chain.getBlockHash(blockNumber);
  const blockHash = hash.toHex();
  const [signedBlock, events] = await Promise.all([
    input.api.rpc.chain.getBlock(hash) as Promise<SignedBlockLike>,
    input.api.query.system.events.at(hash) as Promise<EventRecordLike[]>,
  ]);
  let observed = 0;
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const record = events[eventIndex]!;
    if (record.event?.section !== "balances" || record.event.method !== "Transfer") continue;
    const extrinsicIndex = applyExtrinsicIndex(record.phase);
    if (extrinsicIndex === undefined) continue;
    const transfer = transferDataFromEvent(record.event.data);
    if (!transfer || !sameAccountAddress(transfer.to, input.config.viblyDotReceivingAddress)) continue;

    const sourceId = buildRelayDepositSourceId({
      relayChainId: input.config.getVibRelayChainId,
      blockHash,
      extrinsicIndex,
      eventIndex,
    });
    const result = await saveObservedRelayDeposit(input.store, {
      relayChainId: input.config.getVibRelayChainId,
      sourceId,
      from: transfer.from,
      to: transfer.to,
      amountBaseUnits: transfer.amountBaseUnits,
      dotAmount: decimalFromBaseUnits(transfer.amountBaseUnits, input.config.getVibRelayTokenDecimals),
      blockNumber,
      blockHash,
      extrinsicIndex,
      eventIndex,
      extrinsicHash: signedBlock.block.extrinsics[extrinsicIndex]?.hash?.toHex(),
      finalizedAt: new Date().toISOString(),
    });
    if (result.created) {
      const confirmed = await confirmObservedRelayDeposit(input, result.deposit);
      if (confirmed) {
        input.eventBus?.publish(createEvent({
          type: "GetVibCurveUpdated",
          payload: { networkId: getNetworkId(input.config), depositId: result.deposit.id },
        }));
      }
      observed += 1;
    }
  }
  return observed;
}

async function confirmObservedRelayDeposit(input: {
  config: CoordinatorConfig;
  store: CoordinatorStorePort;
  eventBus?: EventBus;
}, deposit: Awaited<ReturnType<typeof saveObservedRelayDeposit>>["deposit"]): Promise<boolean> {
  try {
    await ingestFinalizedDeposit({
      store: input.store,
      config: input.config,
      observedDepositId: deposit.id,
      accountId: deposit.from,
      paymentId: deposit.extrinsicHash ?? deposit.sourceId,
      finalizedAt: deposit.finalizedAt,
    });
    return true;
  } catch (cause) {
    await markObservedRelayDepositFailed(
      input.store,
      deposit,
      cause instanceof Error ? cause.message : String(cause),
    );
    return false;
  }
}

function applyExtrinsicIndex(phase: unknown): number | undefined {
  const value = phase as { isApplyExtrinsic?: boolean; asApplyExtrinsic?: { toNumber(): number }; toJSON?: () => unknown };
  if (value?.isApplyExtrinsic && value.asApplyExtrinsic) return value.asApplyExtrinsic.toNumber();
  const json = value?.toJSON?.();
  if (typeof json === "number") return json;
  if (json && typeof json === "object" && "applyExtrinsic" in json) {
    const index = (json as { applyExtrinsic?: unknown }).applyExtrinsic;
    if (typeof index === "number") return index;
    if (typeof index === "string" && Number.isFinite(Number(index))) return Number(index);
  }
  return undefined;
}

export function transferDataFromEvent(data: unknown): TransferData | undefined {
  const json = eventDataJson(data);
  if (Array.isArray(json)) {
    const [from, to, amount] = json;
    if (from == null || to == null || amount == null) return undefined;
    return { from: String(from), to: String(to), amountBaseUnits: String(amount) };
  }
  if (json && typeof json === "object") {
    const item = json as Record<string, unknown>;
    const from = item["from"] ?? item["sender"] ?? item["0"];
    const to = item["to"] ?? item["dest"] ?? item["1"];
    const amount = item["amount"] ?? item["value"] ?? item["2"];
    if (from == null || to == null || amount == null) return undefined;
    return { from: String(from), to: String(to), amountBaseUnits: String(amount) };
  }
  return undefined;
}

function eventDataJson(data: unknown): unknown {
  const value = data as { toJSON?: () => unknown; toHuman?: () => unknown };
  return value?.toJSON?.() ?? value?.toHuman?.() ?? data;
}

function sameAccountAddress(left: string, right: string): boolean {
  try {
    return Buffer.compare(Buffer.from(decodeAddress(left)), Buffer.from(decodeAddress(right))) === 0;
  } catch {
    return left === right;
  }
}

async function recordWatcherError(store: CoordinatorStorePort, config: CoordinatorConfig, error: unknown): Promise<void> {
  const previous = await getRelayWatcherState(store, config.getVibRelayChainId);
  const now = new Date().toISOString();
  await saveRelayWatcherState(store, {
    relayChainId: config.getVibRelayChainId,
    status: "degraded",
    sourceUrl: config.getVibRelayRpcUrl,
    depositAddress: config.viblyDotReceivingAddress,
    lastProcessedBlock: previous?.lastProcessedBlock,
    lastFinalizedBlock: previous?.lastFinalizedBlock,
    lastAttemptAt: now,
    lastSuccessfulScanAt: previous?.lastSuccessfulScanAt,
    lastErrorAt: now,
    lastError: error instanceof Error ? error.message : String(error),
    observedCount: previous?.observedCount ?? 0,
  });
}
