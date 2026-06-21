import { v4 as uuidv4 } from "uuid";
import { badRequest, conflict, notFound } from "../../../domain/errors.js";
import type { CoordinatorStorePort } from "../../../db/coordinatorStorePort.js";
import { cryptoWaitReady, signatureVerify } from "@polkadot/util-crypto";
import { verifyMessage, type Address } from "viem";

export const WALLET_CHALLENGE = "wallet.challenge.v1";
export const WALLET_SESSION = "wallet.session.v1";

export type WalletEcosystem = "evm" | "polkadot";
export type WalletAccountKind = "evm" | "substrate";

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

export interface ViblyIdentity {
  viblyAccountId: string;
  evmAddress?: `0x${string}`;
  substrateAddress?: string;
  primaryAddress: string;
  primaryKind: WalletAccountKind;
  role?: "user" | "agent" | "observer" | "reviewer";
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

export function walletKindFromEcosystem(ecosystem: WalletEcosystem): WalletAccountKind {
  return ecosystem === "polkadot" ? "substrate" : "evm";
}

export function ecosystemFromWalletKind(kind: WalletAccountKind): WalletEcosystem {
  return kind === "substrate" ? "polkadot" : "evm";
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
  const domain = input.origin;
  const network = input.chainId ?? "vibly";
  const message = [
    "Sign in to Vibly",
    `Address: ${address}`,
    `Kind: ${walletKindFromEcosystem(input.ecosystem)}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
    `Domain: ${domain}`,
    `Network: ${network}`,
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

async function verifyChallengeSignature(input: {
  challenge: WalletChallengeRecord;
  ecosystem: WalletEcosystem;
  address: string;
  signature: string;
}): Promise<void> {
  const normalizedAddress = normalizeWalletAddress(input.ecosystem, input.address);
  if (input.challenge.ecosystem !== input.ecosystem) throw badRequest("Challenge ecosystem mismatch");
  if (input.challenge.address !== normalizedAddress) throw badRequest("Challenge address mismatch");

  if (input.ecosystem === "evm") {
    const valid = await verifyMessage({
      address: normalizedAddress as Address,
      message: input.challenge.message,
      signature: input.signature as `0x${string}`,
    });
    if (!valid) throw badRequest("Invalid wallet signature");
    return;
  }

  await cryptoWaitReady();
  const verified = signatureVerify(input.challenge.message, input.signature, normalizedAddress);
  if (!verified.isValid) throw badRequest("Invalid wallet signature");
}

async function consumeChallengeRecord(input: {
  store: CoordinatorStorePort;
  challenge: WalletChallengeRecord;
  ecosystem: WalletEcosystem;
  address: string;
  signature: string;
}): Promise<WalletChallengeRecord> {
  if (input.challenge.usedAt) throw conflict("Challenge already used", { challengeId: input.challenge.id });
  if (new Date(input.challenge.expiresAt).getTime() <= Date.now()) throw badRequest("Challenge expired", { challengeId: input.challenge.id });

  await verifyChallengeSignature(input);

  const used = { ...input.challenge, usedAt: new Date().toISOString() };
  await input.store.saveProjection(WALLET_CHALLENGE, input.challenge.id, used);
  return used;
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
  return consumeChallengeRecord({ ...input, challenge });
}

export async function consumeChallengeByMessage(input: {
  store: CoordinatorStorePort;
  message: string;
  ecosystem: WalletEcosystem;
  address: string;
  signature: string;
}): Promise<WalletChallengeRecord> {
  const challenges = await input.store.listProjections<WalletChallengeRecord>(WALLET_CHALLENGE);
  const challenge = challenges.find((candidate) => candidate.message === input.message);
  if (!challenge) throw notFound("WalletChallenge", "message");
  return consumeChallengeRecord({ ...input, challenge });
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

export function buildViblyIdentityFromSession(session: WalletSessionRecord): ViblyIdentity {
  const primaryKind = walletKindFromEcosystem(session.ecosystem);
  const viblyAccountId = session.requestedPrincipalId ?? session.principalBindings[0] ?? session.address;
  return {
    viblyAccountId,
    evmAddress: session.ecosystem === "evm" ? (session.address as `0x${string}`) : undefined,
    substrateAddress: session.ecosystem === "polkadot" ? session.address : undefined,
    primaryAddress: session.address,
    primaryKind,
    role: session.agentBindings.length > 0 ? "agent" : "user",
  };
}
