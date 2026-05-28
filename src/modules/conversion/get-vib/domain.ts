import { createHash } from "crypto";
import { decodeAddress } from "@polkadot/util-crypto";
import type { CoordinatorConfig } from "../../../config/env.js";
import type { CoordinatorStorePort } from "../../../db/coordinatorStorePort.js";
import { badRequest, conflict, notFound } from "../../../domain/errors.js";
import {
  CONVERSION_ORDER,
  GET_VIB_ALLOCATION,
  GET_VIB_CLAIM,
  GET_VIB_DEPOSIT,
  GET_VIB_MANIFEST,
  makeId,
  type ConversionOrderRecord,
} from "../../identity/onboarding/domain.js";
import {
  DEFAULT_CURVE_CONFIG,
  PURCHASE_LIMITS,
  generateCurvePoints,
  getPurchasePhase,
  marketCapAtSold,
  priceAtSold,
  quoteBuyVib,
  quoteVibFromUsd,
  validatePurchase,
  type QuoteResult,
} from "./vibCurve.js";

const LEAF_DOMAIN = Buffer.from("VIB_CLAIM_LEAF_V1");
const NODE_DOMAIN = Buffer.from("VIB_CLAIM_NODE_V1");
const UNIT_DECIMALS = 12;
export const GET_VIB_RELAY_DEPOSIT = "get-vib.relay-deposit";
export const GET_VIB_RELAY_WATCHER_STATE = "get-vib.relay-watcher-state";

export type DepositStatus = "observed" | "confirmed" | "failed";
export type AllocationStatus = "pending_admin" | "confirmed" | "root_included";
export type ClaimStatus = "pending" | "confirmed" | "failed";
export type MerklePosition = "left" | "right";
export type RelayDepositStatus = "observed" | "confirmed" | "failed";
export type RelayWatcherStatus = "disabled" | "syncing" | "healthy" | "degraded";

export interface GetVibConfig {
  networkId: string;
  purchaseEnabled: boolean;
  claimEnabled: boolean;
  paused: boolean;
  depositAddress: string;
  relayTokenSymbol: string;
  vibTokenSymbol: "VIB";
  saleRuleVersion: string;
  dotUsdPrice: number;
  purchaseLimits: {
    minPurchaseUsd: number;
    maxPurchaseUsd: number;
    minPurchaseVib: string;
    maxPurchaseVibPerTx: string;
    maxPurchaseVibPerAccount: string;
    slippageBpsDefault: number;
  };
}

export interface GetVibQuote {
  networkId: string;
  inputAmount: string;
  dotAmount: string;
  paymentAsset: "DOT";
  paymentAmount: string;
  assetUsdPrice: number;
  costUsd: number;
  vibAmount: string;
  vibAmountBaseUnits: string;
  averagePriceUsd: number;
  startPriceUsd: number;
  endPriceUsd: number;
  soldBefore: string;
  soldAfter: string;
  effectiveMarketCapUsd: number;
  depositAddress: string;
  dotReceivingAddress: string;
  saleRuleVersion: string;
  expiresAt: string;
  requiresAdminReview: boolean;
}

export interface DepositRecord {
  id: string;
  networkId: string;
  sourceId: string;
  orderId?: string;
  paymentId?: string;
  accountId: string;
  identityId?: string;
  dotAmount: string;
  paymentAsset?: "DOT" | "USDC";
  paymentAmount?: string;
  costUsd?: number;
  averagePriceUsd?: number;
  startPriceUsd?: number;
  endPriceUsd?: number;
  soldBefore?: string;
  soldAfter?: string;
  status: DepositStatus;
  observedAt: string;
  finalizedAt?: string;
  failureReason?: string;
}

export interface AllocationRecord {
  id: string;
  networkId: string;
  sourceId: string;
  accountId: string;
  identityId?: string;
  dotAmount: string;
  vibAmount: string;
  costUsd?: number;
  averagePriceUsd?: number;
  startPriceUsd?: number;
  endPriceUsd?: number;
  soldBefore?: string;
  soldAfter?: string;
  cumulativeAmount: string;
  saleRuleVersion: string;
  status: AllocationStatus;
  rootVersion?: number;
  createdAt: string;
  confirmedAt?: string;
}

export interface ClaimRecord {
  id: string;
  networkId: string;
  accountId: string;
  identityId?: string;
  rootVersion: number;
  cumulativeAmount: string;
  claimedDelta: string;
  txHash?: string;
  status: ClaimStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AllocationSummary {
  networkId: string;
  accountId: string;
  purchasedAllocation: string;
  claimableAmount: string;
  claimedAmount: string;
  latestRootVersion: number;
  latestMerkleRoot?: string;
}

export interface CurveState {
  sold: string;
  raisedUsd: number;
  curveAllocation: string;
  soldProgressPercent: number;
  currentPriceUsd: number;
  nextPriceUsd: number;
  effectiveMarketCapUsd: number;
  paused: boolean;
  phase: 1 | 2 | 3;
}

export interface MerkleProofItem {
  position: MerklePosition;
  hash: string;
}

export interface ClaimProof {
  networkId: string;
  accountId: string;
  identityId?: string;
  rootVersion: number;
  cumulativeAmount: string;
  merkleRoot: string;
  proof: MerkleProofItem[];
  metadataHash: string;
}

export interface AllocationManifest {
  networkId: string;
  rootVersion: number;
  saleRuleVersion: string;
  merkleRoot: string;
  metadataHash: string;
  totalCumulativeAmount: string;
  allocations: Array<{ accountId: string; identityId?: string; cumulativeAmount: string }>;
  deposits: Array<{ sourceId: string; dotAmount: string; vibAmount: string }>;
  createdAt: string;
}

export interface ObservedRelayDeposit {
  id: string;
  relayChainId: string;
  sourceId: string;
  status: RelayDepositStatus;
  from: string;
  to: string;
  amountBaseUnits: string;
  dotAmount: string;
  blockNumber: number;
  blockHash: string;
  extrinsicIndex: number;
  eventIndex: number;
  extrinsicHash?: string;
  observedAt: string;
  finalizedAt: string;
  confirmedAt?: string;
  confirmedDepositId?: string;
  allocationId?: string;
  orderId?: string;
  accountId?: string;
  failureReason?: string;
}

export interface RelayWatcherState {
  id: string;
  relayChainId: string;
  status: RelayWatcherStatus;
  sourceUrl?: string;
  depositAddress?: string;
  lastProcessedBlock?: number;
  lastFinalizedBlock?: number;
  lastAttemptAt?: string;
  lastSuccessfulScanAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  observedCount: number;
  updatedAt: string;
}

interface MerkleLeaf {
  accountId: string;
  identityId?: string;
  cumulativeAmount: string;
  hash: Buffer;
}

export function getNetworkId(config: CoordinatorConfig): string {
  return config.substrateChainId || "substrate:vibly-solo";
}

export async function getGetVibConfig(_store: CoordinatorStorePort, config: CoordinatorConfig): Promise<GetVibConfig> {
  return {
    networkId: getNetworkId(config),
    purchaseEnabled: Boolean(config.viblyDotReceivingAddress) && !config.getVibCurvePaused,
    claimEnabled: true,
    paused: config.getVibCurvePaused,
    depositAddress: config.viblyDotReceivingAddress,
    relayTokenSymbol: config.getVibRelayTokenSymbol,
    vibTokenSymbol: "VIB",
    saleRuleVersion: "capped-launch-curve-v1",
    dotUsdPrice: config.getVibDotUsdPrice,
    purchaseLimits: {
      minPurchaseUsd: PURCHASE_LIMITS.MIN_PURCHASE_USD,
      maxPurchaseUsd: PURCHASE_LIMITS.MAX_PURCHASE_USD,
      minPurchaseVib: String(PURCHASE_LIMITS.MIN_PURCHASE_VIB),
      maxPurchaseVibPerTx: String(PURCHASE_LIMITS.MAX_PURCHASE_VIB_PER_TX),
      maxPurchaseVibPerAccount: String(PURCHASE_LIMITS.MAX_PURCHASE_VIB_PER_ACCOUNT),
      slippageBpsDefault: PURCHASE_LIMITS.SLIPPAGE_BPS_DEFAULT,
    },
  };
}

export async function quoteGetVibAmount(store: CoordinatorStorePort, config: CoordinatorConfig, dotAmount: string): Promise<GetVibQuote> {
  if (config.getVibCurvePaused) throw badRequest("Get VIB curve is paused");
  const networkId = getNetworkId(config);
  const soldBefore = await completedGetVibAllocationTotal(store, networkId);
  const accountPurchasedTotal = 0n;
  const budgetUsd = paymentUsdFromDot(dotAmount, config);
  const curveQuote = quoteVibFromUsd(soldBefore, budgetUsd, DEFAULT_CURVE_CONFIG);
  validatePurchase({
    soldBefore,
    vibAmount: curveQuote.vibAmount,
    accountPurchasedTotal,
    costUsd: curveQuote.costUsd,
    config: DEFAULT_CURVE_CONFIG,
  });
  const vibAmount = String(curveQuote.vibAmount);
  return {
    networkId,
    inputAmount: dotAmount,
    dotAmount,
    paymentAsset: "DOT",
    paymentAmount: dotAmount,
    assetUsdPrice: config.getVibDotUsdPrice,
    costUsd: roundUsd(curveQuote.costUsd),
    vibAmount,
    vibAmountBaseUnits: toBaseUnits(vibAmount),
    averagePriceUsd: curveQuote.averagePriceUsd,
    startPriceUsd: curveQuote.startPriceUsd,
    endPriceUsd: curveQuote.endPriceUsd,
    soldBefore: String(curveQuote.soldBefore),
    soldAfter: String(curveQuote.soldAfter),
    effectiveMarketCapUsd: marketCapAtSold(curveQuote.soldAfter, DEFAULT_CURVE_CONFIG),
    depositAddress: config.viblyDotReceivingAddress,
    dotReceivingAddress: config.viblyDotReceivingAddress,
    saleRuleVersion: "capped-launch-curve-v1",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    requiresAdminReview: curveQuote.costUsd >= config.getVibAdminReviewUsd,
  };
}

export async function completedGetVibAllocationTotal(store: CoordinatorStorePort, networkId: string): Promise<bigint> {
  const allocations = await listNetworkAllocations(store, networkId);
  return allocations
    .filter((allocation) => allocation.status === "confirmed" || allocation.status === "root_included")
    .reduce((sum, allocation) => sum + BigInt(toWholeVib(allocation.vibAmount)), 0n);
}

export async function createGetVibOrder(input: {
  store: CoordinatorStorePort;
  config: CoordinatorConfig;
  dotAmount: string;
  accountId: string;
  identityId?: string;
  evmAddress?: string;
}): Promise<ConversionOrderRecord> {
  const quote = await quoteGetVibByBudget({
    store: input.store,
    config: input.config,
    accountId: input.accountId,
    dotAmount: input.dotAmount,
  });
  const now = new Date().toISOString();
  const id = makeId("getvib");
  const order: ConversionOrderRecord = {
    id,
    evmAddress: input.evmAddress,
    identityId: input.identityId,
    viblyRootAddress: input.accountId,
    dotAmount: input.dotAmount,
    quotedVibAmount: quote.vibAmount,
    paymentAsset: "DOT",
    paymentAmount: input.dotAmount,
    costUsd: quote.costUsd,
    assetUsdPrice: quote.assetUsdPrice,
    averagePriceUsd: quote.averagePriceUsd,
    startPriceUsd: quote.startPriceUsd,
    endPriceUsd: quote.endPriceUsd,
    soldBefore: quote.soldBefore,
    soldAfter: quote.soldAfter,
    requiresAdminReview: quote.requiresAdminReview,
    memo: id,
    dotReceivingAddress: quote.depositAddress,
    quoteExpiresAt: quote.expiresAt,
    status: "pending_payment",
    createdAt: now,
    updatedAt: now,
  };
  await input.store.saveProjection(CONVERSION_ORDER, id, order);
  return order;
}

export async function getOrder(store: CoordinatorStorePort, orderId: string): Promise<ConversionOrderRecord> {
  const order = await store.getProjection<ConversionOrderRecord>(CONVERSION_ORDER, orderId);
  if (!order) throw notFound("Get VIB order", orderId);
  return order;
}

export async function ingestFinalizedDeposit(input: {
  store: CoordinatorStorePort;
  config: CoordinatorConfig;
  sourceId?: string;
  observedDepositId?: string;
  dotAmount?: string;
  accountId?: string;
  orderId?: string;
  paymentId?: string;
  identityId?: string;
  finalizedAt?: string;
}): Promise<{ deposit: DepositRecord; allocation: AllocationRecord }> {
  const networkId = getNetworkId(input.config);
  if (input.config.getVibCurvePaused) throw badRequest("Get VIB curve is paused");
  const observed = input.observedDepositId
    ? await getObservedRelayDeposit(input.store, input.observedDepositId)
    : input.sourceId
      ? await getObservedRelayDeposit(input.store, input.sourceId)
      : undefined;
  const sourceId = input.sourceId ?? observed?.sourceId;
  const dotAmount = input.dotAmount ?? observed?.dotAmount;
  let paymentId = input.paymentId ?? observed?.extrinsicHash ?? observed?.sourceId;
  const finalizedAt = input.finalizedAt ?? observed?.finalizedAt;
  if (!sourceId) throw badRequest("sourceId or observedDepositId is required");
  if (!dotAmount) throw badRequest("dotAmount or observedDepositId is required");

  const existing = await input.store.getProjection<DepositRecord>(GET_VIB_DEPOSIT, projectionId(networkId, sourceId));
  if (existing) throw conflict("Get VIB deposit already processed", { sourceId, depositId: existing.id });
  const paymentDuplicate = paymentId ? await findDepositByPaymentId(input.store, networkId, paymentId) : undefined;
  if (paymentDuplicate) throw conflict("Get VIB payment already processed", { paymentId, depositId: paymentDuplicate.id });

  const order = input.orderId ? await getOrder(input.store, input.orderId) : undefined;
  if (order?.paymentId && paymentId && order.paymentId !== paymentId) {
    throw badRequest("Get VIB payment tx hash does not match submitted quote", { orderId: order.id, paymentId });
  }
  paymentId = paymentId ?? order?.paymentId;
  if (order?.quoteExpiresAt && new Date(order.quoteExpiresAt).getTime() <= Date.now()) {
    throw badRequest("Get VIB quote expired", { orderId: order.id, quoteExpiresAt: order.quoteExpiresAt });
  }
  if (order && order.status !== "pending_payment" && order.status !== "payment_finalized") {
    throw conflict("Get VIB order cannot be reused", { orderId: order.id, status: order.status });
  }
  const accountId = input.accountId ?? order?.viblyRootAddress;
  if (!accountId) throw badRequest("accountId or orderId is required");

  const lease = await input.store.tryAcquireLease({
    kind: "get-vib.curve",
    resourceId: networkId,
    holderId: "deposit-finalize",
    ttlMs: 30_000,
  });
  if (!lease) throw conflict("Get VIB curve update is busy");

  try {
    const now = new Date().toISOString();
    const soldBefore = await completedGetVibAllocationTotal(input.store, networkId);
    const costUsd = paymentUsdFromDot(dotAmount, input.config);
    const curveQuote = quoteVibFromUsd(soldBefore, costUsd, DEFAULT_CURVE_CONFIG);
    const accountPurchasedTotal = BigInt(toWholeVib(await cumulativeAllocationForAccount(input.store, networkId, accountId)));
    validatePurchase({
      soldBefore,
      vibAmount: curveQuote.vibAmount,
      accountPurchasedTotal,
      costUsd: curveQuote.costUsd,
      config: DEFAULT_CURVE_CONFIG,
    });
    const vibAmount = String(curveQuote.vibAmount);
    const deposit: DepositRecord = {
      id: makeId("deposit"),
      networkId,
      sourceId,
      orderId: input.orderId,
      paymentId,
      accountId,
      identityId: input.identityId ?? order?.identityId,
      dotAmount,
      paymentAsset: "DOT",
      paymentAmount: dotAmount,
      costUsd: roundUsd(curveQuote.costUsd),
      averagePriceUsd: curveQuote.averagePriceUsd,
      startPriceUsd: curveQuote.startPriceUsd,
      endPriceUsd: curveQuote.endPriceUsd,
      soldBefore: String(curveQuote.soldBefore),
      soldAfter: String(curveQuote.soldAfter),
      status: "confirmed",
      observedAt: now,
      finalizedAt: finalizedAt ?? now,
    };

    const cumulativeAmount = addDecimalStrings(await cumulativeAllocationForAccount(input.store, networkId, accountId), vibAmount);
    const allocation: AllocationRecord = {
      id: makeId("alloc"),
      networkId,
      sourceId,
      accountId,
      identityId: deposit.identityId,
      dotAmount,
      vibAmount,
      costUsd: deposit.costUsd,
      averagePriceUsd: deposit.averagePriceUsd,
      startPriceUsd: deposit.startPriceUsd,
      endPriceUsd: deposit.endPriceUsd,
      soldBefore: deposit.soldBefore,
      soldAfter: deposit.soldAfter,
      cumulativeAmount,
      saleRuleVersion: "capped-launch-curve-v1",
      status: "confirmed",
      createdAt: now,
      confirmedAt: now,
    };

    await input.store.saveProjection(GET_VIB_DEPOSIT, projectionId(networkId, sourceId), deposit);
    await input.store.saveProjection(GET_VIB_ALLOCATION, projectionId(networkId, allocation.id), allocation);
    if (order) {
      await input.store.saveProjection(CONVERSION_ORDER, order.id, {
        ...order,
        dotAmount,
        finalVibAmount: vibAmount,
        paymentId: paymentId ?? sourceId,
        costUsd: deposit.costUsd,
        averagePriceUsd: deposit.averagePriceUsd,
        startPriceUsd: deposit.startPriceUsd,
        endPriceUsd: deposit.endPriceUsd,
        soldBefore: deposit.soldBefore,
        soldAfter: deposit.soldAfter,
        status: "completed",
        updatedAt: now,
      });
    }
    if (observed) {
      await input.store.saveProjection(GET_VIB_RELAY_DEPOSIT, observed.id, {
        ...observed,
        status: "confirmed",
        confirmedAt: now,
        confirmedDepositId: deposit.id,
        allocationId: allocation.id,
        orderId: input.orderId,
        accountId,
      } satisfies ObservedRelayDeposit);
    }
    return { deposit, allocation };
  } finally {
    await input.store.releaseLease(lease.id);
  }
}

export async function saveObservedRelayDeposit(
  store: CoordinatorStorePort,
  deposit: Omit<ObservedRelayDeposit, "id" | "status" | "observedAt"> & { id?: string; status?: RelayDepositStatus; observedAt?: string },
): Promise<{ deposit: ObservedRelayDeposit; created: boolean }> {
  const id = deposit.id ?? deposit.sourceId;
  const existing = await store.getProjection<ObservedRelayDeposit>(GET_VIB_RELAY_DEPOSIT, id);
  if (existing) return { deposit: existing, created: false };
  const now = new Date().toISOString();
  const record: ObservedRelayDeposit = {
    ...deposit,
    id,
    status: deposit.status ?? "observed",
    observedAt: deposit.observedAt ?? now,
  };
  await store.saveProjection(GET_VIB_RELAY_DEPOSIT, id, record);
  return { deposit: record, created: true };
}

export async function getObservedRelayDeposit(store: CoordinatorStorePort, id: string): Promise<ObservedRelayDeposit | undefined> {
  return store.getProjection<ObservedRelayDeposit>(GET_VIB_RELAY_DEPOSIT, id);
}

export async function listObservedRelayDeposits(
  store: CoordinatorStorePort,
  input: { status?: RelayDepositStatus; limit?: number } = {},
): Promise<ObservedRelayDeposit[]> {
  const limit = input.limit ?? 50;
  return (await store.listProjections<ObservedRelayDeposit>(GET_VIB_RELAY_DEPOSIT))
    .filter((record) => !input.status || record.status === input.status)
    .sort((left, right) => right.blockNumber - left.blockNumber || right.eventIndex - left.eventIndex)
    .slice(0, limit);
}

export async function getRelayWatcherState(store: CoordinatorStorePort, relayChainId: string): Promise<RelayWatcherState | undefined> {
  return store.getProjection<RelayWatcherState>(GET_VIB_RELAY_WATCHER_STATE, relayChainId);
}

export async function saveRelayWatcherState(
  store: CoordinatorStorePort,
  state: Omit<RelayWatcherState, "id" | "updatedAt"> & { id?: string; updatedAt?: string },
): Promise<RelayWatcherState> {
  const record: RelayWatcherState = {
    ...state,
    id: state.id ?? state.relayChainId,
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  };
  await store.saveProjection(GET_VIB_RELAY_WATCHER_STATE, record.id, record);
  return record;
}

export function buildRelayDepositSourceId(input: {
  relayChainId: string;
  blockHash: string;
  extrinsicIndex: number;
  eventIndex: number;
}): string {
  return `${input.relayChainId}:${input.blockHash}:${input.extrinsicIndex}:${input.eventIndex}`;
}

export function decimalFromBaseUnits(value: string | bigint, decimals: number): string {
  const amount = typeof value === "bigint" ? value : BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = String(amount % scale).padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export async function getAllocationSummary(store: CoordinatorStorePort, config: CoordinatorConfig, accountId: string): Promise<AllocationSummary> {
  const networkId = getNetworkId(config);
  const purchasedAllocation = await cumulativeAllocationForAccount(store, networkId, accountId);
  const claimedAmount = await claimedAmountForAccount(store, networkId, accountId);
  const manifest = await latestManifest(store, networkId);
  return {
    networkId,
    accountId,
    purchasedAllocation,
    claimedAmount,
    claimableAmount: maxDecimalString("0", subtractDecimalStrings(purchasedAllocation, claimedAmount)),
    latestRootVersion: manifest?.rootVersion ?? 0,
    latestMerkleRoot: manifest?.merkleRoot,
  };
}

export async function getRecords(store: CoordinatorStorePort, config: CoordinatorConfig, accountId: string) {
  const networkId = getNetworkId(config);
  const [deposits, allocations, claims] = await Promise.all([
    listNetworkDeposits(store, networkId),
    listNetworkAllocations(store, networkId),
    listNetworkClaims(store, networkId),
  ]);
  return {
    deposits: deposits.filter((record) => record.accountId === accountId).sort(descTime("observedAt")),
    allocations: allocations.filter((record) => record.accountId === accountId).sort(descTime("createdAt")),
    claims: claims.filter((record) => record.accountId === accountId).sort(descTime("createdAt")),
  };
}

export async function buildAndSaveManifest(store: CoordinatorStorePort, config: CoordinatorConfig): Promise<AllocationManifest> {
  const networkId = getNetworkId(config);
  const previous = await latestManifest(store, networkId);
  const rootVersion = (previous?.rootVersion ?? 0) + 1;
  const allocations = await listNetworkAllocations(store, networkId);
  const deposits = await listNetworkDeposits(store, networkId);
  const cumulative = cumulativeAllocations(allocations);
  const tree = buildMerkleTree(cumulative);
  const manifestWithoutHash = {
    networkId,
    rootVersion,
    saleRuleVersion: "conversion-v1",
    merkleRoot: tree.root,
    totalCumulativeAmount: cumulative.reduce((sum, row) => addDecimalStrings(sum, row.cumulativeAmount), "0"),
    allocations: cumulative.map(({ accountId, identityId, cumulativeAmount }) => ({ accountId, identityId, cumulativeAmount })),
    deposits: deposits.map((deposit) => {
      const allocation = allocations.find((item) => item.sourceId === deposit.sourceId);
      return { sourceId: deposit.sourceId, dotAmount: deposit.dotAmount, vibAmount: allocation?.vibAmount ?? "0" };
    }),
    createdAt: new Date().toISOString(),
  };
  const metadataHash = hashHex(Buffer.from(canonicalJson(manifestWithoutHash)));
  const manifest: AllocationManifest = { ...manifestWithoutHash, metadataHash };
  await store.saveProjection(GET_VIB_MANIFEST, projectionId(networkId, String(rootVersion).padStart(10, "0")), manifest);

  await Promise.all(
    allocations
      .filter((allocation) => allocation.status === "confirmed")
      .map((allocation) =>
        store.saveProjection(GET_VIB_ALLOCATION, projectionId(networkId, allocation.id), {
          ...allocation,
          status: "root_included",
          rootVersion,
        }),
      ),
  );
  return manifest;
}

export async function getClaimProof(store: CoordinatorStorePort, config: CoordinatorConfig, accountId: string): Promise<ClaimProof> {
  const networkId = getNetworkId(config);
  const manifest = await latestManifest(store, networkId);
  if (!manifest) throw notFound("Get VIB manifest", networkId);
  const tree = buildMerkleTree(manifest.allocations);
  const proof = tree.proofs.get(accountId);
  const allocation = manifest.allocations.find((item) => item.accountId === accountId);
  if (!allocation || !proof) throw notFound("Get VIB allocation", accountId);
  return {
    networkId,
    accountId,
    identityId: allocation.identityId,
    rootVersion: manifest.rootVersion,
    cumulativeAmount: allocation.cumulativeAmount,
    merkleRoot: manifest.merkleRoot,
    proof,
    metadataHash: manifest.metadataHash,
  };
}

export async function recordClaim(input: {
  store: CoordinatorStorePort;
  config: CoordinatorConfig;
  accountId: string;
  identityId?: string;
  rootVersion: number;
  cumulativeAmount: string;
  claimedDelta: string;
  txHash?: string;
  status?: ClaimStatus;
}): Promise<ClaimRecord> {
  const now = new Date().toISOString();
  const claim: ClaimRecord = {
    id: makeId("claim"),
    networkId: getNetworkId(input.config),
    accountId: input.accountId,
    identityId: input.identityId,
    rootVersion: input.rootVersion,
    cumulativeAmount: input.cumulativeAmount,
    claimedDelta: input.claimedDelta,
    txHash: input.txHash,
    status: input.status ?? "confirmed",
    createdAt: now,
    updatedAt: now,
  };
  await input.store.saveProjection(GET_VIB_CLAIM, projectionId(claim.networkId, claim.id), claim);
  return claim;
}

export async function quoteGetVibByBudget(input: {
  store: CoordinatorStorePort;
  config: CoordinatorConfig;
  accountId?: string;
  budgetUsd?: number;
  dotAmount?: string;
  vibAmount?: string;
}): Promise<GetVibQuote> {
  if (input.config.getVibCurvePaused) throw badRequest("Get VIB curve is paused");
  const networkId = getNetworkId(input.config);
  const soldBefore = await completedGetVibAllocationTotal(input.store, networkId);
  const accountPurchasedTotal = input.accountId
    ? BigInt(toWholeVib(await cumulativeAllocationForAccount(input.store, networkId, input.accountId)))
    : 0n;
  const curveQuote = input.vibAmount
    ? quoteBuyVib(soldBefore, BigInt(toWholeVib(input.vibAmount)), DEFAULT_CURVE_CONFIG)
    : quoteVibFromUsd(
        soldBefore,
        input.budgetUsd ?? paymentUsdFromDot(input.dotAmount ?? "0", input.config),
        DEFAULT_CURVE_CONFIG,
      );
  validatePurchase({
    soldBefore,
    vibAmount: curveQuote.vibAmount,
    accountPurchasedTotal,
    costUsd: curveQuote.costUsd,
    config: DEFAULT_CURVE_CONFIG,
  });
  const dotAmount = input.dotAmount ?? trimDecimal(curveQuote.costUsd / input.config.getVibDotUsdPrice);
  return quoteFromCurveQuote({
    networkId,
    dotAmount,
    config: input.config,
    curveQuote,
  });
}

export async function submitGetVibPayment(input: {
  store: CoordinatorStorePort;
  quoteId: string;
  paymentTxHash: string;
}): Promise<ConversionOrderRecord> {
  const order = await getOrder(input.store, input.quoteId);
  if (new Date(order.quoteExpiresAt).getTime() <= Date.now()) throw badRequest("Get VIB quote expired", { quoteId: input.quoteId });
  if (order.status !== "pending_payment") throw conflict("Get VIB quote cannot be reused", { quoteId: input.quoteId, status: order.status });
  const existingPayment = await findAnyOrderByPaymentId(input.store, input.paymentTxHash);
  if (existingPayment) throw conflict("Get VIB payment tx hash already submitted", { paymentTxHash: input.paymentTxHash });
  const updated: ConversionOrderRecord = {
    ...order,
    paymentId: input.paymentTxHash,
    status: "payment_finalized",
    updatedAt: new Date().toISOString(),
  };
  await input.store.saveProjection(CONVERSION_ORDER, order.id, updated);
  return updated;
}

export async function getCurveState(store: CoordinatorStorePort, config: CoordinatorConfig): Promise<CurveState> {
  const sold = await completedGetVibAllocationTotal(store, getNetworkId(config));
  const nextSold = sold < DEFAULT_CURVE_CONFIG.curveAllocation ? sold + 1n : sold;
  const raisedUsd = await completedGetVibRaiseUsd(store, getNetworkId(config));
  return {
    sold: String(sold),
    raisedUsd: roundUsd(raisedUsd),
    curveAllocation: String(DEFAULT_CURVE_CONFIG.curveAllocation),
    soldProgressPercent: Number(sold * 10_000n / DEFAULT_CURVE_CONFIG.curveAllocation) / 100,
    currentPriceUsd: priceAtSold(sold, DEFAULT_CURVE_CONFIG),
    nextPriceUsd: priceAtSold(nextSold, DEFAULT_CURVE_CONFIG),
    effectiveMarketCapUsd: marketCapAtSold(sold, DEFAULT_CURVE_CONFIG),
    paused: config.getVibCurvePaused,
    phase: getPurchasePhase(sold),
  };
}

export async function getCurve(store: CoordinatorStorePort, config: CoordinatorConfig) {
  const [state, generated] = await Promise.all([
    getCurveState(store, config),
    Promise.resolve(generateCurvePoints(DEFAULT_CURVE_CONFIG)),
  ]);
  const points = generated
    .filter((_, index) => index % 20 === 0 || index === generated.length - 1)
    .map((point) => ({
      soldVib: String(point.sold),
      price: trimDecimal(point.priceUsd),
      priceUsd: point.priceUsd,
      marketCapUsd: point.marketCapUsd,
      effectiveCirculation: String(point.effectiveCirculation),
    }));
  return { state, points };
}

function buildMerkleTree(rows: Array<{ accountId: string; identityId?: string; cumulativeAmount: string }>): { root: string; proofs: Map<string, MerkleProofItem[]> } {
  const leaves = rows
    .map((row) => ({ ...row, hash: hashLeaf(row) }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.accountId), Buffer.from(right.accountId)));
  const proofs = new Map<string, MerkleProofItem[]>();
  for (const leaf of leaves) proofs.set(leaf.accountId, []);
  if (leaves.length === 0) return { root: hashHex(Buffer.alloc(0)), proofs };

  let level: MerkleLeaf[] = leaves;
  while (level.length > 1) {
    const next: MerkleLeaf[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1];
      if (!right) {
        next.push(left);
        continue;
      }
      proofs.get(left.accountId)?.push({ position: "right", hash: toHex(right.hash) });
      proofs.get(right.accountId)?.push({ position: "left", hash: toHex(left.hash) });
      next.push({
        accountId: left.accountId,
        identityId: left.identityId,
        cumulativeAmount: left.cumulativeAmount,
        hash: hashNode(left.hash, right.hash),
      });
    }
    level = next;
  }
  return { root: toHex(level[0].hash), proofs };
}

function hashLeaf(row: { accountId: string; identityId?: string; cumulativeAmount: string }): Buffer {
  return hash(Buffer.concat([LEAF_DOMAIN, encodeAccountId(row.accountId), encodeScaleBytes(row.identityId ?? ""), encodeU128(toBaseUnits(row.cumulativeAmount))]));
}

function hashNode(left: Buffer, right: Buffer): Buffer {
  return hash(Buffer.concat([NODE_DOMAIN, left, right]));
}

function hashHex(input: Buffer): string {
  return toHex(hash(input));
}

function hash(input: Buffer): Buffer {
  return createHash("blake2b512", { outputLength: 32 }).update(input).digest();
}

function toHex(buffer: Buffer): string {
  return `0x${buffer.toString("hex")}`;
}

function encodeAccountId(value: string): Buffer {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value.slice(2), "hex");
  return Buffer.from(decodeAddress(value));
}

function encodeScaleBytes(value: string): Buffer {
  const raw = Buffer.from(value);
  return Buffer.concat([encodeCompactLength(raw.length), raw]);
}

function encodeCompactLength(length: number): Buffer {
  if (length < 1 << 6) return Buffer.from([length << 2]);
  if (length < 1 << 14) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE((length << 2) | 0b01, 0);
    return buffer;
  }
  const buffer = Buffer.alloc(5);
  buffer[0] = 0b10;
  buffer.writeUInt32LE(length, 1);
  return buffer;
}

function encodeU128(value: string): Buffer {
  let amount = BigInt(value);
  const buffer = Buffer.alloc(16);
  for (let index = 0; index < 16; index += 1) {
    buffer[index] = Number(amount & 0xffn);
    amount >>= 8n;
  }
  return buffer;
}

function toBaseUnits(value: string): string {
  const [wholeRaw, fractionRaw = ""] = String(value).split(".");
  const sign = wholeRaw.startsWith("-") ? "-" : "";
  const whole = wholeRaw.replace("-", "") || "0";
  const fraction = `${fractionRaw}${"0".repeat(UNIT_DECIMALS)}`.slice(0, UNIT_DECIMALS);
  return `${sign}${BigInt(whole) * 10n ** BigInt(UNIT_DECIMALS) + BigInt(fraction)}`;
}

function fromBaseUnits(value: bigint): string {
  const scale = 10n ** BigInt(UNIT_DECIMALS);
  const whole = value / scale;
  const fraction = String(value % scale).padStart(UNIT_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function addDecimalStrings(left: string, right: string): string {
  return fromBaseUnits(BigInt(toBaseUnits(left)) + BigInt(toBaseUnits(right)));
}

function subtractDecimalStrings(left: string, right: string): string {
  return fromBaseUnits(BigInt(toBaseUnits(left)) - BigInt(toBaseUnits(right)));
}

function maxDecimalString(left: string, right: string): string {
  return BigInt(toBaseUnits(left)) >= BigInt(toBaseUnits(right)) ? left : right;
}

function quoteFromCurveQuote(input: {
  networkId: string;
  dotAmount: string;
  config: CoordinatorConfig;
  curveQuote: QuoteResult;
}): GetVibQuote {
  const vibAmount = String(input.curveQuote.vibAmount);
  return {
    networkId: input.networkId,
    inputAmount: input.dotAmount,
    dotAmount: input.dotAmount,
    paymentAsset: "DOT",
    paymentAmount: input.dotAmount,
    assetUsdPrice: input.config.getVibDotUsdPrice,
    costUsd: roundUsd(input.curveQuote.costUsd),
    vibAmount,
    vibAmountBaseUnits: toBaseUnits(vibAmount),
    averagePriceUsd: input.curveQuote.averagePriceUsd,
    startPriceUsd: input.curveQuote.startPriceUsd,
    endPriceUsd: input.curveQuote.endPriceUsd,
    soldBefore: String(input.curveQuote.soldBefore),
    soldAfter: String(input.curveQuote.soldAfter),
    effectiveMarketCapUsd: marketCapAtSold(input.curveQuote.soldAfter, DEFAULT_CURVE_CONFIG),
    depositAddress: input.config.viblyDotReceivingAddress,
    dotReceivingAddress: input.config.viblyDotReceivingAddress,
    saleRuleVersion: "capped-launch-curve-v1",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    requiresAdminReview: input.curveQuote.costUsd >= input.config.getVibAdminReviewUsd,
  };
}

function paymentUsdFromDot(dotAmountRaw: string, config: CoordinatorConfig): number {
  const dotAmount = Number(dotAmountRaw);
  if (!Number.isFinite(dotAmount) || dotAmount <= 0) throw badRequest("DOT amount must be positive");
  if (config.viblyConversionMinDot > 0 && dotAmount < config.viblyConversionMinDot) {
    throw badRequest("DOT amount is below minimum", { minDot: config.viblyConversionMinDot });
  }
  if (config.viblyConversionMaxDot > 0 && dotAmount > config.viblyConversionMaxDot) {
    throw badRequest("DOT amount exceeds maximum", { maxDot: config.viblyConversionMaxDot });
  }
  return dotAmount * config.getVibDotUsdPrice;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function toWholeVib(value: string): string {
  const trimmed = String(value || "0").trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw badRequest("Invalid VIB amount", { value });
  return trimmed.split(".")[0] || "0";
}

function trimDecimal(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

async function cumulativeAllocationForAccount(store: CoordinatorStorePort, networkId: string, accountId: string): Promise<string> {
  const allocations = await listNetworkAllocations(store, networkId);
  return allocations
    .filter((allocation) => allocation.accountId === accountId && (allocation.status === "confirmed" || allocation.status === "root_included"))
    .reduce((sum, allocation) => addDecimalStrings(sum, allocation.vibAmount), "0");
}

async function claimedAmountForAccount(store: CoordinatorStorePort, networkId: string, accountId: string): Promise<string> {
  const claims = await listNetworkClaims(store, networkId);
  return claims
    .filter((claim) => claim.accountId === accountId && claim.status === "confirmed")
    .reduce((sum, claim) => addDecimalStrings(sum, claim.claimedDelta), "0");
}

async function completedGetVibRaiseUsd(store: CoordinatorStorePort, networkId: string): Promise<number> {
  const allocations = await listNetworkAllocations(store, networkId);
  return allocations
    .filter((allocation) => allocation.status === "confirmed" || allocation.status === "root_included")
    .reduce((sum, allocation) => sum + (allocation.costUsd ?? 0), 0);
}

async function findDepositByPaymentId(store: CoordinatorStorePort, networkId: string, paymentId: string): Promise<DepositRecord | undefined> {
  return (await listNetworkDeposits(store, networkId)).find((deposit) => deposit.paymentId === paymentId);
}

async function findAnyOrderByPaymentId(store: CoordinatorStorePort, paymentId: string): Promise<ConversionOrderRecord | undefined> {
  return (await store.listProjections<ConversionOrderRecord>(CONVERSION_ORDER)).find((order) => order.paymentId === paymentId);
}

function cumulativeAllocations(allocations: AllocationRecord[]): Array<{ accountId: string; identityId?: string; cumulativeAmount: string }> {
  const byAccount = new Map<string, { accountId: string; identityId?: string; cumulativeAmount: string }>();
  for (const allocation of allocations.filter((item) => item.status === "confirmed" || item.status === "root_included")) {
    const existing = byAccount.get(allocation.accountId);
    byAccount.set(allocation.accountId, {
      accountId: allocation.accountId,
      identityId: allocation.identityId ?? existing?.identityId,
      cumulativeAmount: addDecimalStrings(existing?.cumulativeAmount ?? "0", allocation.vibAmount),
    });
  }
  return [...byAccount.values()].sort((left, right) => left.accountId.localeCompare(right.accountId));
}

async function latestManifest(store: CoordinatorStorePort, networkId: string): Promise<AllocationManifest | undefined> {
  const manifests = (await store.listProjections<AllocationManifest>(GET_VIB_MANIFEST))
    .filter((manifest) => manifest.networkId === networkId)
    .sort((left, right) => right.rootVersion - left.rootVersion);
  return manifests[0];
}

async function listNetworkDeposits(store: CoordinatorStorePort, networkId: string): Promise<DepositRecord[]> {
  return (await store.listProjections<DepositRecord>(GET_VIB_DEPOSIT)).filter((record) => record.networkId === networkId);
}

async function listNetworkAllocations(store: CoordinatorStorePort, networkId: string): Promise<AllocationRecord[]> {
  return (await store.listProjections<AllocationRecord>(GET_VIB_ALLOCATION)).filter((record) => record.networkId === networkId);
}

async function listNetworkClaims(store: CoordinatorStorePort, networkId: string): Promise<ClaimRecord[]> {
  return (await store.listProjections<ClaimRecord>(GET_VIB_CLAIM)).filter((record) => record.networkId === networkId);
}

function projectionId(networkId: string, id: string): string {
  return `${networkId}:${id}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function descTime<T extends { observedAt?: string; createdAt?: string }>(field: "observedAt" | "createdAt") {
  return (left: T, right: T) =>
    new Date(right[field] ?? 0).getTime() - new Date(left[field] ?? 0).getTime();
}
