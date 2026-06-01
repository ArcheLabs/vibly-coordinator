import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../../domain/apiTypes.js";
import { badRequest, notFound } from "../../../domain/errors.js";
import { envelopeKey } from "../../../domain/schemas.js";
import { authPolicy } from "../../../plugins/authPolicy.js";
import { IdentityRepository } from "../../../contexts/identity/repository.js";
import type { AgentProfile, AgentSessionKey, Principal } from "../../../contexts/identity/types.js";
import { WALLET_SESSION, ensureActiveWalletSession, type WalletSessionRecord } from "../wallet/domain.js";
import {
  AGENT_ENROLLMENT_CHALLENGE,
  AGENT_SECURITY_EVENT,
  AGENT_STAKE_RECEIPT,
  buildEnrollmentChallenge,
  consumeEnrollmentChallenge,
  makeId,
  normalizeDescriptor,
  verifyRootAuthorization,
  type AgentDescriptor,
  type AgentSecurityEvent,
} from "./domain.js";
import {
  AGENT_RUNTIME_TOKEN,
  createAgentRuntimeToken,
  hashAgentRuntimeToken,
  type AgentRuntimeTokenRecord,
} from "./runtimeToken.js";

function sessionTokenFromRequest(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers["x-wallet-session"];
  return Array.isArray(raw) ? raw[0] : raw;
}

const OPEN_OBJECT = { type: "object" as const, additionalProperties: true };

const agentEnrollmentsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { descriptor: AgentDescriptor } }>(
    "/agent-enrollments/challenges",
    {
      ...authPolicy("wallet-session", {
        tags: ["Agents"],
        summary: "Create an agent session-key enrollment challenge",
        body: {
          type: "object",
          required: ["descriptor"],
          properties: { descriptor: OPEN_OBJECT },
        },
        response: { 200: envelopeKey("challenge", OPEN_OBJECT) },
      }),
    },
    async (request) => {
      const descriptor = normalizeDescriptor(request.body.descriptor);
      const origin = request.headers.origin ?? request.headers.host ?? "unknown-origin";
      const challenge = buildEnrollmentChallenge({ descriptor, origin });
      await fastify.coordinatorStore.saveProjection(AGENT_ENROLLMENT_CHALLENGE, challenge.id, challenge);
      return ok({ challenge });
    },
  );

  fastify.post<{
    Body: {
      kind: "bond" | "request-unbond" | "cancel-unbond" | "release-unbond";
      identityId: string;
      chainAgentId: string;
      chainId: string;
      txHash: string;
      amount?: string;
      principalId?: string;
    };
  }>(
    "/agent-stakes/receipts",
    {
      ...authPolicy("wallet-session", {
        tags: ["Agents"],
        summary: "Record a wallet-submitted agent stake transaction receipt",
        body: {
          type: "object",
          required: ["kind", "identityId", "chainAgentId", "chainId", "txHash"],
          properties: {
            kind: { type: "string", enum: ["bond", "request-unbond", "cancel-unbond", "release-unbond"] },
            identityId: { type: "string" },
            chainAgentId: { type: "string" },
            chainId: { type: "string" },
            txHash: { type: "string" },
            amount: { type: "string" },
            principalId: { type: "string" },
          },
        },
        response: { 200: envelopeKey("receipt", OPEN_OBJECT) },
      }),
    },
    async (request) => {
      const token = sessionTokenFromRequest(request.headers as Record<string, string | string[] | undefined>);
      if (!token) throw badRequest("Wallet session token is required");
      const session = ensureActiveWalletSession(
        await fastify.coordinatorStore.getProjection<WalletSessionRecord>(WALLET_SESSION, token),
        token,
      );
      const now = new Date().toISOString();
      const receipt = {
        id: makeId("asr"),
        submittedBy: session.address,
        ...request.body,
        createdAt: now,
      };
      await fastify.coordinatorStore.saveProjection(AGENT_STAKE_RECEIPT, receipt.id, receipt);
      const event = makeSecurityEvent({
        type: "AgentStakeReceiptRecorded",
        principalId: request.body.principalId,
        title: `Stake ${request.body.kind} submitted`,
        meta: `${request.body.chainAgentId} · ${request.body.txHash}`,
        severity: "info",
      });
      await fastify.coordinatorStore.saveProjection(AGENT_SECURITY_EVENT, event.id, event);
      return ok({ receipt: { ...receipt, event } });
    },
  );

  fastify.post<{
    Body: {
      challengeId: string;
      sessionSignature: string;
      rootAuthorizationSignature: string;
    };
  }>(
    "/agent-enrollments/authorizations",
    {
      ...authPolicy("wallet-session", {
        tags: ["Agents"],
        summary: "Authorize an agent session key with the connected root wallet",
        body: {
          type: "object",
          required: ["challengeId", "sessionSignature", "rootAuthorizationSignature"],
          properties: {
            challengeId: { type: "string" },
            sessionSignature: { type: "string" },
            rootAuthorizationSignature: { type: "string" },
          },
        },
        response: { 200: envelopeKey("authorization", OPEN_OBJECT) },
      }),
    },
    async (request) => {
      const token = sessionTokenFromRequest(request.headers as Record<string, string | string[] | undefined>);
      if (!token) throw badRequest("Wallet session token is required");
      const session = ensureActiveWalletSession(
        await fastify.coordinatorStore.getProjection<WalletSessionRecord>(WALLET_SESSION, token),
        token,
      );
      const challenge = await consumeEnrollmentChallenge({
        store: fastify.coordinatorStore,
        challengeId: request.body.challengeId,
        sessionSignature: request.body.sessionSignature,
      });
      await verifyRootAuthorization({
        ecosystem: session.ecosystem,
        address: session.address,
        message: challenge.rootAuthorizationMessage,
        signature: request.body.rootAuthorizationSignature,
      });

      const descriptor = challenge.descriptor;
      const now = new Date().toISOString();
      const principalId = descriptor.principalId ?? makePrincipalId(descriptor.sessionPublicKey);
      const repo = new IdentityRepository(fastify.coordinatorStore);
      const existingPrincipal = await repo.getPrincipal(principalId);
      const principal: Principal = {
        id: principalId,
        kind: "agent",
        displayName: descriptor.displayName,
        organizationIds: descriptor.organizationIds ?? ["default"],
        createdAt: existingPrincipal?.createdAt ?? now,
        updatedAt: now,
      };
      await repo.savePrincipal(principal);

      const existingProfile = await repo.getAgentProfile(principalId);
      const sessionKey: AgentSessionKey = {
        id: makeId("ask"),
        publicKey: descriptor.sessionPublicKey,
        keyType: descriptor.keyType ?? "sr25519",
        status: "active",
        scopes: descriptor.scopes ?? [],
        stakeLimit: descriptor.stakeLimit,
        expiresAt: descriptor.expiresAt,
        authorizedBy: session.address,
        proof: {
          challengeId: challenge.id,
          sessionSignature: request.body.sessionSignature,
          rootSignature: request.body.rootAuthorizationSignature,
          message: challenge.rootAuthorizationMessage,
        },
        createdAt: now,
      };
      const existingKeys = existingProfile?.sessionKeys ?? [];
      const activeKeys = existingKeys.filter((key) => key.publicKey !== sessionKey.publicKey || key.status !== "active");
      const profile: AgentProfile = {
        principalId,
        displayName: descriptor.displayName,
        capabilities: descriptor.capabilities ?? [],
        organizationIds: descriptor.organizationIds ?? ["default"],
        sessionKeys: [...activeKeys, sessionKey],
        chainId: descriptor.chainId ?? existingProfile?.chainId ?? fastify.config.substrateChainId,
        identityId: descriptor.identityId ?? existingProfile?.identityId,
        chainAgentId: descriptor.chainAgentId ?? existingProfile?.chainAgentId,
        dutyStatus: existingProfile?.dutyStatus ?? "active",
        stakeStatus: existingProfile?.stakeStatus,
        createdAt: existingProfile?.createdAt ?? now,
        updatedAt: now,
      };
      await repo.saveAgentProfile(profile);

      const runtimeToken = createAgentRuntimeToken();
      const runtimeTokenRecord: AgentRuntimeTokenRecord = {
        id: hashAgentRuntimeToken(runtimeToken),
        tokenHash: hashAgentRuntimeToken(runtimeToken),
        principalId,
        sessionKeyId: sessionKey.id,
        sessionPublicKey: sessionKey.publicKey,
        authorizedBy: session.address,
        scopes: sessionKey.scopes,
        status: "active",
        createdAt: now,
        expiresAt: sessionKey.expiresAt,
      };
      await fastify.coordinatorStore.saveProjection(AGENT_RUNTIME_TOKEN, runtimeTokenRecord.id, runtimeTokenRecord);

      const event = makeSecurityEvent({
        type: "SessionKeyAuthorized",
        principalId,
        title: "Session key authorized",
        meta: `${descriptor.displayName} · scopes: ${(descriptor.scopes ?? []).join(", ")}`,
        severity: "success",
      });
      await fastify.coordinatorStore.saveProjection(AGENT_SECURITY_EVENT, event.id, event);
      return ok({ authorization: { principalId, sessionKey, profile, event, runtimeToken } });
    },
  );

  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/agent-enrollments/:id/revoke",
    {
      ...authPolicy("wallet-session", {
        tags: ["Agents"],
        summary: "Revoke an authorized agent session key",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: { type: "object", properties: { reason: { type: "string" } } },
        response: { 200: envelopeKey("authorization", OPEN_OBJECT) },
      }),
    },
    async (request) => {
      const token = sessionTokenFromRequest(request.headers as Record<string, string | string[] | undefined>);
      if (!token) throw badRequest("Wallet session token is required");
      const session = ensureActiveWalletSession(
        await fastify.coordinatorStore.getProjection<WalletSessionRecord>(WALLET_SESSION, token),
        token,
      );
      const repo = new IdentityRepository(fastify.coordinatorStore);
      const profiles = await repo.listAgentProfiles();
      const profile = profiles.find((item) => (item.sessionKeys ?? []).some((key) => key.id === request.params.id));
      if (!profile) throw notFound("AgentSessionKey", request.params.id);
      const key = (profile.sessionKeys ?? []).find((item) => item.id === request.params.id);
      if (key?.authorizedBy !== session.address) throw badRequest("Wallet session does not control this session key");
      const now = new Date().toISOString();
      const updated: AgentProfile = {
        ...profile,
        sessionKeys: (profile.sessionKeys ?? []).map((item) =>
          item.id === request.params.id ? { ...item, status: "revoked", revokedAt: now } : item,
        ),
        updatedAt: now,
      };
      await repo.saveAgentProfile(updated);
      const event = makeSecurityEvent({
        type: "SessionKeyRevoked",
        principalId: profile.principalId,
        title: "Session key revoked",
        meta: `${profile.displayName} · ${request.body.reason ?? "manual revoke"}`,
        severity: "warning",
      });
      await fastify.coordinatorStore.saveProjection(AGENT_SECURITY_EVENT, event.id, event);
      return ok({ authorization: { principalId: profile.principalId, profile: updated, event } });
    },
  );
};

function makePrincipalId(publicKey: string): string {
  const cleaned = publicKey.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || makeId("agent");
  return `agent_${cleaned}`;
}

function makeSecurityEvent(input: Omit<AgentSecurityEvent, "id" | "createdAt">): AgentSecurityEvent {
  return { ...input, id: makeId("ase"), createdAt: new Date().toISOString() };
}

export default agentEnrollmentsRoutes;
