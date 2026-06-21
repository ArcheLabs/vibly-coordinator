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
export const IDENTITY_EVM_LINK = "identity.evm-link";
export const IDENTITY_EVM_UNLINK = "identity.evm-unlink";

export type ClaimStatus = "pending" | "submitted" | "finalized" | "completed" | "failed";

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

export interface EvmAddressLinkRecord {
  id: string;
  evmAddress: string;
  viblyAccountId: string;
  substrateAddress?: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  chainSubmissionId?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvmAddressUnlinkRecord {
  id: string;
  evmAddress: string;
  viblyAccountId?: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  chainSubmissionId?: string;
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
