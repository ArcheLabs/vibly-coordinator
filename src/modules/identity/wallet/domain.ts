import { v4 as uuidv4 } from "uuid";
import { badRequest, conflict, notFound } from "../../../domain/errors.js";
import type { CoordinatorStorePort } from "../../../db/coordinatorStorePort.js";
import { cryptoWaitReady, signatureVerify } from "@polkadot/util-crypto";

export const WALLET_CHALLENGE = "wallet.challenge.v1";
export const WALLET_SESSION = "wallet.session.v1";

export type WalletEcosystem = "evm" | "polkadot";

export interface WalletChallengeRecord {
  id: string;
  nonce: string;
  ecosystem: WalletEcosystem;
  address: string;
  chainId?: string;
  requestedPrincipalId?: string;
  message: string;
  issuedAt: string;
  expiresAt: string;
  usedAt?: string;
}

export interface WalletSessionRecord {
  token: string;
  ecosystem: WalletEcosystem;
  address: string;
  chainId?: string;
  requestedPrincipalId?: string;
  principalBindings: string[];
  agentBindings: string[];
  capabilityHints: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

function makeId(prefix: string): string {
  return `${prefix}_${uuidv4().replace(/-/g, "").slice(0, 24)}`;
}

export function normalizeWalletAddress(ecosystem: WalletEcosystem, address: string): string {
  const trimmed = address.trim();
  if (!trimmed) throw badRequest("Address is required");
  if (ecosystem === "evm") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) throw badRequest("Invalid EVM address", { address });
    return `0x${trimmed.slice(2).toLowerCase()}`;
  }
  if (trimmed.length < 20 || trimmed.length > 80) throw badRequest("Invalid Polkadot/Substrate address", { address });
  return trimmed;
}

export function buildWalletChallenge(input: {
  ecosystem: WalletEcosystem;
  address: string;
  origin: string;
  chainId?: string;
  requestedPrincipalId?: string;
  ttlMs?: number;
}): WalletChallengeRecord {
  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 5 * 60_000)).toISOString();
  const id = makeId("wch");
  const nonce = makeId("nonce");
  const address = normalizeWalletAddress(input.ecosystem, input.address);
  const chainLabel = input.chainId ? `Chain: ${input.chainId}` : "Chain: n/a";
  const requestedPrincipal = input.requestedPrincipalId ?? "any";
  const message = [
    "Vibly Wallet Login",
    `Origin: ${input.origin}`,
    `Ecosystem: ${input.ecosystem}`,
    `Address: ${address}`,
    chainLabel,
    `Requested Principal: ${requestedPrincipal}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
  ].join("\n");

  return {
    id,
    nonce,
    ecosystem: input.ecosystem,
    address,
    chainId: input.chainId,
    requestedPrincipalId: input.requestedPrincipalId,
    message,
    issuedAt,
    expiresAt,
  };
}

export async function consumeChallenge(input: {
  store: CoordinatorStorePort;
  challengeId: string;
  ecosystem: WalletEcosystem;
  address: string;
  signature: string;
}): Promise<WalletChallengeRecord> {
  const challenge = await input.store.getProjection<WalletChallengeRecord>(WALLET_CHALLENGE, input.challengeId);
  if (!challenge) throw notFound("WalletChallenge", input.challengeId);
  if (challenge.usedAt) throw conflict("Challenge already used", { challengeId: input.challengeId });
  if (new Date(challenge.expiresAt).getTime() <= Date.now()) throw badRequest("Challenge expired", { challengeId: input.challengeId });

  const normalizedAddress = normalizeWalletAddress(input.ecosystem, input.address);
  if (challenge.ecosystem !== input.ecosystem) throw badRequest("Challenge ecosystem mismatch");
  if (challenge.address !== normalizedAddress) throw badRequest("Challenge address mismatch");

  await cryptoWaitReady();
  const verified = signatureVerify(challenge.message, input.signature, normalizedAddress);
  if (!verified.isValid) throw badRequest("Invalid wallet signature");

  const used = { ...challenge, usedAt: new Date().toISOString() };
  await input.store.saveProjection(WALLET_CHALLENGE, challenge.id, used);
  return used;
}

export function buildWalletSession(input: {
  challenge: WalletChallengeRecord;
  principalBindings: string[];
  agentBindings: string[];
  capabilityHints: string[];
  ttlMs?: number;
}): WalletSessionRecord {
  const now = new Date();
  return {
    token: makeId("ws"),
    ecosystem: input.challenge.ecosystem,
    address: input.challenge.address,
    chainId: input.challenge.chainId,
    requestedPrincipalId: input.challenge.requestedPrincipalId,
    principalBindings: input.principalBindings,
    agentBindings: input.agentBindings,
    capabilityHints: input.capabilityHints,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? 30 * 60_000)).toISOString(),
  };
}

export function ensureActiveWalletSession(session: WalletSessionRecord | undefined, token: string): WalletSessionRecord {
  if (!session) throw notFound("WalletSession", token);
  if (session.revokedAt) throw badRequest("Wallet session is revoked", { token });
  if (new Date(session.expiresAt).getTime() <= Date.now()) throw badRequest("Wallet session is expired", { token });
  return session;
}
