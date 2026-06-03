import { v4 as uuidv4 } from "uuid";
import { cryptoWaitReady, signatureVerify } from "@polkadot/util-crypto";
import { badRequest, conflict, notFound } from "../../../domain/errors.js";
import type { CoordinatorStorePort } from "../../../db/coordinatorStorePort.js";

export const AGENT_ENROLLMENT_CHALLENGE = "agent_enrollment_challenge_v1";
export const AGENT_SESSION_AUTHORIZATION = "agent_session_authorization_v1";
export const AGENT_SECURITY_EVENT = "agent_security_event_v1";
export const AGENT_STAKE_RECEIPT = "agent_stake_receipt_v1";

export interface AgentDescriptor {
  principalId?: string;
  displayName: string;
  sessionPublicKey: string;
  keyType?: "sr25519" | "ed25519" | "ecdsa" | "unknown";
  capabilities?: string[];
  organizationIds?: string[];
  scopes?: string[];
  stakeLimit?: string;
  expiresAt?: string;
  runtime?: Record<string, unknown>;
  chainId?: string;
  identityId?: string;
  chainAgentId?: string;
}

export interface AgentEnrollmentChallenge {
  id: string;
  descriptor: AgentDescriptor;
  message: string;
  rootAuthorizationMessage: string;
  issuedAt: string;
  expiresAt: string;
  usedAt?: string;
}

export interface AgentSessionAuthorization {
  id: string;
  sessionPublicKey: string;
  keyType: "sr25519" | "ed25519" | "ecdsa" | "unknown";
  displayName?: string;
  organizationIds: string[];
  authorizedBy: string;
  rootEcosystem: "evm" | "polkadot";
  status: "pending_client" | "completed" | "revoked";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  principalId?: string;
  sessionKeyId?: string;
}

export interface AgentSecurityEvent {
  id: string;
  type: string;
  principalId?: string;
  title: string;
  meta?: string;
  severity: "info" | "warning" | "danger" | "success";
  createdAt: string;
}

export function makeId(prefix: string): string {
  return `${prefix}_${uuidv4().replace(/-/g, "").slice(0, 24)}`;
}

export function normalizeDescriptor(input: AgentDescriptor): AgentDescriptor {
  if (!input || typeof input !== "object") throw badRequest("Agent descriptor is required");
  if (!input.displayName?.trim()) throw badRequest("Agent displayName is required");
  if (!input.sessionPublicKey?.trim()) throw badRequest("Agent sessionPublicKey is required");
  return {
    ...input,
    displayName: input.displayName.trim(),
    sessionPublicKey: input.sessionPublicKey.trim(),
    keyType: input.keyType ?? "sr25519",
    capabilities: (input.capabilities ?? []).map(String).filter(Boolean),
    organizationIds: input.organizationIds?.length ? input.organizationIds.map(String).filter(Boolean) : ["default"],
    scopes: input.scopes?.length ? input.scopes.map(String).filter(Boolean) : ["availability", "task_result", "pause_duty", "resume_duty"],
  };
}

export function normalizeSessionPublicKey(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw badRequest("Agent sessionPublicKey is required");
  const value = input.trim();
  if (!/^0x[0-9a-fA-F]{32,132}$/.test(value) && !/^[1-9A-HJ-NP-Za-km-z]{32,80}$/.test(value)) {
    throw badRequest("Agent sessionPublicKey must be an SS58 address or hex public key");
  }
  return value;
}

export function buildEnrollmentCompletionMessage(input: AgentSessionAuthorization): string {
  return [
    "Vibly Agent Enrollment Completion",
    `Authorization: ${input.id}`,
    `Session Public Key: ${input.sessionPublicKey}`,
    `Authorized By: ${input.authorizedBy}`,
    `Issued At: ${input.createdAt}`,
  ].join("\n");
}

export function buildEnrollmentChallenge(input: { descriptor: AgentDescriptor; origin: string; ttlMs?: number }): AgentEnrollmentChallenge {
  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 10 * 60_000)).toISOString();
  const id = makeId("aen");
  const descriptor = normalizeDescriptor(input.descriptor);
  const descriptorHash = JSON.stringify({
    displayName: descriptor.displayName,
    sessionPublicKey: descriptor.sessionPublicKey,
    capabilities: descriptor.capabilities ?? [],
    organizationIds: descriptor.organizationIds ?? [],
    identityId: descriptor.identityId,
    chainAgentId: descriptor.chainAgentId,
  });
  const message = [
    "Vibly Agent Session Enrollment",
    `Origin: ${input.origin}`,
    `Challenge: ${id}`,
    `Agent: ${descriptor.displayName}`,
    `Session Public Key: ${descriptor.sessionPublicKey}`,
    `Descriptor: ${descriptorHash}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
  ].join("\n");
  const rootAuthorizationMessage = [
    "Vibly Root Wallet Agent Authorization",
    `Challenge: ${id}`,
    `Agent: ${descriptor.displayName}`,
    `Session Public Key: ${descriptor.sessionPublicKey}`,
    `Scopes: ${(descriptor.scopes ?? []).join(",")}`,
    `Stake Limit: ${descriptor.stakeLimit ?? "none"}`,
    `Expires At: ${descriptor.expiresAt ?? "none"}`,
  ].join("\n");

  return { id, descriptor, message, rootAuthorizationMessage, issuedAt, expiresAt };
}

export async function consumeEnrollmentChallenge(input: {
  store: CoordinatorStorePort;
  challengeId: string;
  sessionSignature: string;
}): Promise<AgentEnrollmentChallenge> {
  const challenge = await input.store.getProjection<AgentEnrollmentChallenge>(AGENT_ENROLLMENT_CHALLENGE, input.challengeId);
  if (!challenge) throw notFound("AgentEnrollmentChallenge", input.challengeId);
  if (challenge.usedAt) throw conflict("Agent enrollment challenge already used", { challengeId: input.challengeId });
  if (new Date(challenge.expiresAt).getTime() <= Date.now()) throw badRequest("Agent enrollment challenge expired", { challengeId: input.challengeId });
  if (!input.sessionSignature) throw badRequest("Session signature is required");

  await cryptoWaitReady();
  const verified = signatureVerify(challenge.message, input.sessionSignature, challenge.descriptor.sessionPublicKey);
  if (!verified.isValid) throw badRequest("Invalid agent session signature");

  const used = { ...challenge, usedAt: new Date().toISOString() };
  await input.store.saveProjection(AGENT_ENROLLMENT_CHALLENGE, used.id, used);
  return used;
}

export async function verifyRootAuthorization(input: {
  ecosystem: "evm" | "polkadot";
  address: string;
  message: string;
  signature: string;
}): Promise<void> {
  if (!input.signature) throw badRequest("Root authorization signature is required");
  if (input.ecosystem === "evm") {
    if (!/^0x[0-9a-fA-F]{130}$/.test(input.signature)) throw badRequest("Invalid EVM root authorization signature");
    return;
  }
  await cryptoWaitReady();
  const verified = signatureVerify(input.message, input.signature, input.address);
  if (!verified.isValid) throw badRequest("Invalid root authorization signature");
}

export async function verifySessionCompletion(input: {
  message: string;
  sessionPublicKey: string;
  sessionSignature: string;
}): Promise<void> {
  if (!input.sessionSignature) throw badRequest("Session signature is required");
  await cryptoWaitReady();
  const verified = signatureVerify(input.message, input.sessionSignature, input.sessionPublicKey);
  if (!verified.isValid) throw badRequest("Invalid agent session signature");
}
