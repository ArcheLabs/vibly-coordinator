import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ok } from "../../../domain/apiTypes.js";
import { badRequest, notFound } from "../../../domain/errors.js";
import { envelopeKey } from "../../../domain/schemas.js";
import { authPolicy } from "../../../plugins/authPolicy.js";
import { IdentityRepository } from "../../../contexts/identity/repository.js";
import type { AgentProfile, AgentSessionKey, Principal } from "../../../contexts/identity/types.js";
import { WALLET_SESSION, ensureActiveWalletSession, type WalletSessionRecord } from "../wallet/domain.js";
import {
  AGENT_ENROLLMENT_CHALLENGE,
  AGENT_SESSION_AUTHORIZATION,
  AGENT_SECURITY_EVENT,
  AGENT_STAKE_RECEIPT,
  buildEnrollmentCompletionMessage,
  buildEnrollmentChallenge,
  consumeEnrollmentChallenge,
  makeId,
  normalizeDescriptor,
  normalizeSessionPublicKey,
  verifySessionCompletion,
  verifyRootAuthorization,
  type AgentDescriptor,
  type AgentSessionAuthorization,
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
  async function requireWalletSession(request: FastifyRequest): Promise<WalletSessionRecord> {
    const token = sessionTokenFromRequest(request.headers as Record<string, string | string[] | undefined>);
    if (!token) throw badRequest("Wallet session token is required");
    return ensureActiveWalletSession(
      await fastify.coordinatorStore.getProjection<WalletSessionRecord>(WALLET_SESSION, token),
      token,
    );
  }

  async function saveAgentEnrollmentAuthorization(input: {
    descriptor: AgentDescriptor;
    authorizedBy: string;
    proof: AgentSessionKey["proof"];
  }) {
    const descriptor = normalizeDescriptor(input.descriptor);
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
      authorizedBy: input.authorizedBy,
      proof: input.proof,
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
      authorizedBy: input.authorizedBy,
      scopes: sessionKey.scopes,
      status: "active",
      createdAt: now,
      expiresAt: sessionKey.expiresAt,
    };
    const existingRuntimeTokens = await fastify.coordinatorStore.listProjections<AgentRuntimeTokenRecord>(AGENT_RUNTIME_TOKEN);
    await Promise.all(existingRuntimeTokens
      .filter((token) => token.principalId === principalId && token.sessionPublicKey === sessionKey.publicKey && token.status === "active")
      .map((token) => fastify.coordinatorStore.saveProjection(AGENT_RUNTIME_TOKEN, token.id, { ...token, status: "revoked" as const })));
    await fastify.coordinatorStore.saveProjection(AGENT_RUNTIME_TOKEN, runtimeTokenRecord.id, runtimeTokenRecord);

    const event = makeSecurityEvent({
      type: "SessionKeyAuthorized",
      principalId,
      title: "Session key authorized",
      meta: `${descriptor.displayName} · scopes: ${(descriptor.scopes ?? []).join(", ")}`,
      severity: "success",
    });
    await fastify.coordinatorStore.saveProjection(AGENT_SECURITY_EVENT, event.id, event);
    return { principalId, sessionKey, profile, event, runtimeToken };
  }

  fastify.post<{ Body: { descriptor: AgentDescriptor } }>(
    "/agent-enrollments",
    {
      ...authPolicy("wallet-session", {
        tags: ["Agents"],
        summary: "Directly add an agent session key from a client enrollment descriptor",
        body: {
          type: "object",
          required: ["descriptor"],
          properties: { descriptor: OPEN_OBJECT },
        },
        response: { 200: envelopeKey("authorization", OPEN_OBJECT) },
      }),
    },
    async (request) => {
      const session = await requireWalletSession(request);
      const authorization = await saveAgentEnrollmentAuthorization({
        descriptor: request.body.descriptor,
        authorizedBy: session.address,
        proof: {
          mode: "direct-console",
          message: "Wallet session authenticated direct Console enrollment",
        },
      });
      return ok({ authorization });
    },
  );

  fastify.post<{
    Body: {
      sessionPublicKey: string;
      keyType?: AgentSessionAuthorization["keyType"];
      displayName?: string;
      organizationIds?: string[];
    };
  }>(
    "/agent-enrollments/public-keys",
    {
      ...authPolicy("wallet-session", {
        tags: ["Agents"],
        summary: "Authorize a local agent session public key with the connected root wallet",
        body: {
          type: "object",
          required: ["sessionPublicKey"],
          properties: {
            sessionPublicKey: { type: "string" },
            keyType: { type: "string", enum: ["sr25519", "ed25519", "ecdsa", "unknown"] },
            displayName: { type: "string" },
            organizationIds: { type: "array", items: { type: "string" } },
          },
        },
        response: { 200: envelopeKey("authorization", OPEN_OBJECT) },
      }),
    },
    async (request) => {
      const session = await requireWalletSession(request);
      const sessionPublicKey = normalizeSessionPublicKey(request.body.sessionPublicKey);
      const id = makeSessionAuthorizationId(sessionPublicKey);
      const existing = await fastify.coordinatorStore.getProjection<AgentSessionAuthorization>(AGENT_SESSION_AUTHORIZATION, id);
      if (existing && existing.authorizedBy !== session.address) {
        throw badRequest("Agent session public key is already authorized by another root wallet");
      }
      const now = new Date().toISOString();
      const authorization: AgentSessionAuthorization = {
        ...(existing ?? {
          id,
          sessionPublicKey,
          status: "pending_client" as const,
          createdAt: now,
        }),
        keyType: request.body.keyType ?? existing?.keyType ?? "sr25519",
        displayName: request.body.displayName?.trim() || existing?.displayName,
        organizationIds: request.body.organizationIds?.length ? request.body.organizationIds.map(String).filter(Boolean) : existing?.organizationIds ?? ["default"],
        authorizedBy: session.address,
        rootEcosystem: session.ecosystem,
        updatedAt: now,
      };
      await fastify.coordinatorStore.saveProjection(AGENT_SESSION_AUTHORIZATION, authorization.id, authorization);
      return ok({
        authorization: {
          ...authorization,
          completionMessage: authorization.status !== "revoked" ? buildEnrollmentCompletionMessage(authorization) : undefined,
        },
      });
    },
  );

  fastify.get<{ Querystring: { sessionPublicKey?: string } }>(
    "/agent-enrollments/status",
    {
      ...authPolicy("public-read", {
        tags: ["Agents"],
        summary: "Read Console authorization status for a local agent session public key",
        querystring: {
          type: "object",
          required: ["sessionPublicKey"],
          properties: { sessionPublicKey: { type: "string" } },
        },
        response: { 200: envelopeKey("authorization", OPEN_OBJECT) },
      }),
    },
    async (request) => {
      const sessionPublicKey = normalizeSessionPublicKey(request.query.sessionPublicKey);
      const id = makeSessionAuthorizationId(sessionPublicKey);
      const authorization = await fastify.coordinatorStore.getProjection<AgentSessionAuthorization>(AGENT_SESSION_AUTHORIZATION, id);
      if (!authorization) {
        return ok({ authorization: { id, sessionPublicKey, status: "not_found" } });
      }
      return ok({
        authorization: {
          ...authorization,
          completionMessage: authorization.status !== "revoked" ? buildEnrollmentCompletionMessage(authorization) : undefined,
        },
      });
    },
  );

  fastify.post<{ Body: { descriptor: AgentDescriptor; sessionSignature: string } }>(
    "/agent-enrollments/complete",
    {
      ...authPolicy("public-read", {
        tags: ["Agents"],
        summary: "Complete a Console-authorized agent enrollment with the local session key",
        body: {
          type: "object",
          required: ["descriptor", "sessionSignature"],
          properties: {
            descriptor: OPEN_OBJECT,
            sessionSignature: { type: "string" },
          },
        },
        response: { 200: envelopeKey("authorization", OPEN_OBJECT) },
      }),
    },
    async (request) => {
      const descriptor = normalizeDescriptor(request.body.descriptor);
      const sessionPublicKey = normalizeSessionPublicKey(descriptor.sessionPublicKey);
      const id = makeSessionAuthorizationId(sessionPublicKey);
      const rootAuthorization = await fastify.coordinatorStore.getProjection<AgentSessionAuthorization>(AGENT_SESSION_AUTHORIZATION, id);
      if (!rootAuthorization) throw notFound("AgentSessionAuthorization", id);
      if (rootAuthorization.status === "revoked") throw badRequest("Agent session authorization is revoked");
      if (rootAuthorization.sessionPublicKey !== descriptor.sessionPublicKey) throw badRequest("Agent descriptor sessionPublicKey does not match authorization");
      const message = buildEnrollmentCompletionMessage(rootAuthorization);
      await verifySessionCompletion({
        message,
        sessionPublicKey: rootAuthorization.sessionPublicKey,
        sessionSignature: request.body.sessionSignature,
      });

      const authorization = await saveAgentEnrollmentAuthorization({
        descriptor: {
          ...descriptor,
          keyType: descriptor.keyType ?? rootAuthorization.keyType,
          organizationIds: descriptor.organizationIds?.length ? descriptor.organizationIds : rootAuthorization.organizationIds,
          displayName: descriptor.displayName || rootAuthorization.displayName || "Local Agent",
        },
        authorizedBy: rootAuthorization.authorizedBy,
        proof: {
          mode: "console-public-key",
          authorizationId: rootAuthorization.id,
          sessionSignature: request.body.sessionSignature,
          message,
        },
      });
      const now = new Date().toISOString();
      const completed: AgentSessionAuthorization = {
        ...rootAuthorization,
        status: "completed",
        updatedAt: now,
        completedAt: rootAuthorization.completedAt ?? now,
        principalId: authorization.principalId,
        sessionKeyId: authorization.sessionKey.id,
      };
      await fastify.coordinatorStore.saveProjection(AGENT_SESSION_AUTHORIZATION, completed.id, completed);
      return ok({ authorization: { ...authorization, rootAuthorization: completed } });
    },
  );

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
      const session = await requireWalletSession(request);
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

      const authorization = await saveAgentEnrollmentAuthorization({
        descriptor: challenge.descriptor,
        authorizedBy: session.address,
        proof: {
          mode: "challenge",
          challengeId: challenge.id,
          sessionSignature: request.body.sessionSignature,
          rootSignature: request.body.rootAuthorizationSignature,
          message: challenge.rootAuthorizationMessage,
        },
      });
      return ok({ authorization });
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

function makeSessionAuthorizationId(publicKey: string): string {
  const cleaned = publicKey.replace(/[^a-zA-Z0-9]/g, "").slice(0, 48) || makeId("asa");
  return `asa_${cleaned}`;
}

function makeSecurityEvent(input: Omit<AgentSecurityEvent, "id" | "createdAt">): AgentSecurityEvent {
  return { ...input, id: makeId("ase"), createdAt: new Date().toISOString() };
}

export default agentEnrollmentsRoutes;
