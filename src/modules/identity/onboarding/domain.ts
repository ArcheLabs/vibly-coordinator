import { v4 as uuidv4 } from "uuid";
import type { CoordinatorStorePort } from "../../../db/coordinatorStorePort.js";
import type { CoordinatorConfig } from "../../../config/env.js";
import { badRequest, conflict, notFound } from "../../../domain/errors.js";

export const AIRDROP_ELIGIBILITY = "identity.airdrop.eligibility";
export const AIRDROP_PAYLOAD = "identity.airdrop.payload";
export const AIRDROP_CLAIM = "identity.airdrop.claim";
export const ROOT_ROTATION_PAYLOAD = "identity.root-rotation.payload";
export const ROOT_ROTATION = "identity.root-rotation";
export const IDENTITY_STATUS = "identity.status";
export const CONVERSION_CONFIG = "conversion.dot-vib.config";
export const CONVERSION_ORDER = "conversion.dot-vib.order";

export type ClaimStatus = "pending" | "submitted" | "finalized" | "completed" | "failed";
export type ConversionOrderStatus = "quoted" | "pending_payment" | "payment_finalized" | "submitted" | "completed" | "failed";

export interface AirdropEligibility {
  evmAddress: string;
  rootAmount: string;
  agentRegistrarAmount: string;
  enabled: boolean;
  metadata?: Record<string, unknown>;
  updatedAt: string;
}

export interface SigningPayloadRecord {
  nonce: string;
  action: "airdrop_claim" | "root_rotation";
  evmAddress: string;
  viblyRootAddress: string;
  agentRegistrarAddress?: string;
  payload: Record<string, unknown>;
  message: string;
  expiresAt: string;
  usedAt?: string;
  createdAt: string;
}

export interface AirdropClaimRecord {
  id: string;
  evmAddress: string;
  viblyRootAddress: string;
  agentRegistrarAddress: string;
  rootAmount: string;
  agentRegistrarAmount: string;
  status: ClaimStatus;
  chainSubmissionId?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityStatusRecord {
  evmAddress: string;
  identityId?: string;
  viblyRootAddress: string;
  agentRegistrarAddress?: string;
  airdropClaimId?: string;
  status: "active" | "pending";
  updatedAt: string;
}

export interface RootRotationRecord {
  id: string;
  evmAddress: string;
  previousRootAddress?: string;
  newRootAddress: string;
  status: ClaimStatus;
  chainSubmissionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversionConfigRecord {
  totalCapVib: string;
  initialRate: string;
  slope: string;
  minDot: string;
  maxDot: string;
  dotReceivingAddress: string;
  updatedAt: string;
}

export interface ConversionOrderRecord {
  id: string;
  evmAddress?: string;
  identityId?: string;
  viblyRootAddress: string;
  dotAmount: string;
  quotedVibAmount: string;
  finalVibAmount?: string;
  memo: string;
  dotReceivingAddress: string;
  quoteExpiresAt: string;
  status: ConversionOrderStatus;
  paymentId?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export function normalizeEvmAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw badRequest("Invalid EVM address", { address });
  return `0x${address.slice(2).toLowerCase()}`;
}

export function makeId(prefix: string): string {
  return `${prefix}_${uuidv4().replace(/-/g, "").slice(0, 18)}`;
}

export function buildSigningPayload(input: {
  config: CoordinatorConfig;
  action: "airdrop_claim" | "root_rotation";
  evmAddress: string;
  viblyRootAddress: string;
  agentRegistrarAddress?: string;
  ttlMs?: number;
}): SigningPayloadRecord {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 10 * 60_000)).toISOString();
  const nonce = makeId("sig");
  const payload = {
    domain: input.config.viblyAirdropDomain,
    chainId: input.config.evmChainId,
    action: input.action,
    evmAddress: input.evmAddress,
    viblyRootAddress: input.viblyRootAddress,
    ...(input.agentRegistrarAddress ? { agentRegistrarAddress: input.agentRegistrarAddress } : {}),
    nonce,
    expiresAt,
  };
  return {
    nonce,
    action: input.action,
    evmAddress: input.evmAddress,
    viblyRootAddress: input.viblyRootAddress,
    agentRegistrarAddress: input.agentRegistrarAddress,
    payload,
    message: JSON.stringify(payload),
    expiresAt,
    createdAt: now.toISOString(),
  };
}

export async function verifyStoredPayload(input: {
  store: CoordinatorStorePort;
  kind: string;
  nonce: string;
  evmAddress: string;
  signature: string;
}): Promise<SigningPayloadRecord> {
  const record = await input.store.getProjection<SigningPayloadRecord>(input.kind, input.nonce);
  if (!record) throw notFound("Signing payload", input.nonce);
  if (record.usedAt) throw conflict("Signing payload already used", { nonce: input.nonce });
  if (new Date(record.expiresAt).getTime() <= Date.now()) throw badRequest("Signing payload expired", { nonce: input.nonce });
  const evmAddress = normalizeEvmAddress(input.evmAddress);
  if (record.evmAddress !== evmAddress) throw badRequest("Signing payload address mismatch");
  const valid = isPlausibleEoaSignature(input.signature);
  if (!valid) throw badRequest("Invalid EVM signature");
  const updated = { ...record, usedAt: new Date().toISOString() };
  await input.store.saveProjection(input.kind, input.nonce, updated);
  return updated;
}

function isPlausibleEoaSignature(signature: string): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(signature);
}

export async function getConversionConfig(store: CoordinatorStorePort, config: CoordinatorConfig): Promise<ConversionConfigRecord> {
  return (
    (await store.getProjection<ConversionConfigRecord>(CONVERSION_CONFIG, "active")) ?? {
      totalCapVib: String(config.viblyConversionTotalCap),
      initialRate: String(config.viblyConversionInitialRate),
      slope: String(config.viblyConversionSlope),
      minDot: String(config.viblyConversionMinDot),
      maxDot: String(config.viblyConversionMaxDot),
      dotReceivingAddress: config.viblyDotReceivingAddress,
      updatedAt: new Date().toISOString(),
    }
  );
}

export function quoteVibAmount(dotAmountRaw: string | number, config: ConversionConfigRecord, alreadyIssuedVib = 0): string {
  const dotAmount = Number(dotAmountRaw);
  const minDot = Number(config.minDot);
  const maxDot = Number(config.maxDot);
  if (!Number.isFinite(dotAmount) || dotAmount <= 0) throw badRequest("DOT amount must be positive");
  if (minDot > 0 && dotAmount < minDot) throw badRequest("DOT amount is below minimum", { minDot });
  if (maxDot > 0 && dotAmount > maxDot) throw badRequest("DOT amount exceeds maximum", { maxDot });
  const initialRate = Number(config.initialRate);
  const slope = Number(config.slope);
  const effectiveRate = Math.max(initialRate / (1 + slope * alreadyIssuedVib), 0);
  const vibAmount = dotAmount * effectiveRate;
  const totalCap = Number(config.totalCapVib);
  if (totalCap > 0 && alreadyIssuedVib + vibAmount > totalCap) throw badRequest("VIB conversion cap exceeded");
  return vibAmount.toFixed(6).replace(/\.?0+$/, "");
}

export async function completedConversionTotal(store: CoordinatorStorePort): Promise<number> {
  const orders = await store.listProjections<ConversionOrderRecord>(CONVERSION_ORDER);
  return orders
    .filter((order) => order.status === "completed" && order.finalVibAmount)
    .reduce((sum, order) => sum + Number(order.finalVibAmount), 0);
}
