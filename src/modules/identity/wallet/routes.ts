import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../../domain/apiTypes.js";
import { envelope, envelopeKey } from "../../../domain/schemas.js";
import { authPolicy } from "../../../plugins/authPolicy.js";
import { IdentityRepository } from "../../../contexts/identity/repository.js";
import {
  WALLET_CHALLENGE,
  WALLET_SESSION,
  buildWalletChallenge,
  buildWalletSession,
  consumeChallenge,
  ensureActiveWalletSession,
  normalizeWalletAddress,
  type WalletChallengeRecord,
  type WalletEcosystem,
  type WalletSessionRecord,
} from "./domain.js";

function sessionTokenFromRequest(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers["x-wallet-session"];
  if (!raw) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

const walletRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: {
      ecosystem: WalletEcosystem;
      address: string;
      chainId?: string;
      requestedPrincipalId?: string;
    };
  }>(
    "/wallet/challenges",
    {
      ...authPolicy("public-read", {
        tags: ["Wallet"],
        summary: "Create wallet login challenge",
        body: {
          type: "object",
          required: ["ecosystem", "address"],
          properties: {
            ecosystem: { type: "string", enum: ["evm", "polkadot"] },
            address: { type: "string" },
            chainId: { type: "string" },
            requestedPrincipalId: { type: "string" },
          },
        },
        response: {
          200: envelopeKey("challenge", {
            type: "object",
            required: ["id", "nonce", "ecosystem", "address", "message", "issuedAt", "expiresAt"],
            properties: {
              id: { type: "string" },
              nonce: { type: "string" },
              ecosystem: { type: "string" },
              address: { type: "string" },
              chainId: { type: "string" },
              requestedPrincipalId: { type: "string" },
              message: { type: "string" },
              issuedAt: { type: "string" },
              expiresAt: { type: "string" },
            },
          }),
        },
      }),
    },
    async (request) => {
      const origin = request.headers.origin ?? request.headers.host ?? "unknown-origin";
      const challenge = buildWalletChallenge({
        ecosystem: request.body.ecosystem,
        address: request.body.address,
        chainId: request.body.chainId,
        requestedPrincipalId: request.body.requestedPrincipalId,
        origin,
      });
      await fastify.coordinatorStore.saveProjection(WALLET_CHALLENGE, challenge.id, challenge);
      return ok({ challenge });
    },
  );

  fastify.post<{
    Body: {
      challengeId: string;
      ecosystem: WalletEcosystem;
      address: string;
      signature: string;
    };
  }>(
    "/wallet/sessions",
    {
      ...authPolicy("public-read", {
        tags: ["Wallet"],
        summary: "Exchange signed challenge for wallet session",
        body: {
          type: "object",
          required: ["challengeId", "ecosystem", "address", "signature"],
          properties: {
            challengeId: { type: "string" },
            ecosystem: { type: "string", enum: ["evm", "polkadot"] },
            address: { type: "string" },
            signature: { type: "string" },
          },
        },
        response: {
          200: envelope({
            type: "object",
            required: ["session"],
            properties: {
              session: {
                anyOf: [
                  {
                    type: "object",
                    required: ["token", "ecosystem", "address", "expiresAt", "principalBindings", "agentBindings", "capabilityHints"],
                    properties: {
                      token: { type: "string" },
                      ecosystem: { type: "string" },
                      address: { type: "string" },
                      chainId: { type: "string" },
                      requestedPrincipalId: { type: "string" },
                      principalBindings: { type: "array", items: { type: "string" } },
                      agentBindings: { type: "array", items: { type: "string" } },
                      capabilityHints: { type: "array", items: { type: "string" } },
                      createdAt: { type: "string" },
                      expiresAt: { type: "string" },
                    },
                  },
                  { type: "null" },
                ],
              },
            },
          }),
        },
      }),
    },
    async (request) => {
      const challenge = await consumeChallenge({
        store: fastify.coordinatorStore,
        challengeId: request.body.challengeId,
        ecosystem: request.body.ecosystem,
        address: request.body.address,
        signature: request.body.signature,
      });

      const normalizedAddress = normalizeWalletAddress(request.body.ecosystem, request.body.address);
      const identityRepo = new IdentityRepository(fastify.coordinatorStore);
      const allProfiles = await identityRepo.listAgentProfiles();
      const agentBindings = allProfiles.filter((profile) => profile.evmAddress === normalizedAddress).map((profile) => profile.principalId);
      const principalBindings = challenge.requestedPrincipalId ? [challenge.requestedPrincipalId] : [];
      const capabilityHints = allProfiles
        .filter((profile) => principalBindings.includes(profile.principalId) || agentBindings.includes(profile.principalId))
        .flatMap((profile) => profile.capabilities);

      const session = buildWalletSession({
        challenge,
        principalBindings,
        agentBindings,
        capabilityHints,
      });
      await fastify.coordinatorStore.saveProjection(WALLET_SESSION, session.token, session);
      return ok({ session });
    },
  );

  fastify.get(
    "/wallet/session",
    {
      ...authPolicy("public-read", {
        tags: ["Wallet"],
        summary: "Get current wallet session by token",
        response: {
          200: envelopeKey("session", {
            type: "object",
            required: ["token", "ecosystem", "address", "expiresAt", "principalBindings", "agentBindings", "capabilityHints"],
            properties: {
              token: { type: "string" },
              ecosystem: { type: "string" },
              address: { type: "string" },
              chainId: { type: "string" },
              requestedPrincipalId: { type: "string" },
              principalBindings: { type: "array", items: { type: "string" } },
              agentBindings: { type: "array", items: { type: "string" } },
              capabilityHints: { type: "array", items: { type: "string" } },
              createdAt: { type: "string" },
              expiresAt: { type: "string" },
            },
          }),
        },
      }),
    },
    async (request) => {
      const token = sessionTokenFromRequest(request.headers as Record<string, string | string[] | undefined>);
      if (!token) {
        return ok({ session: null });
      }
      const session = ensureActiveWalletSession(
        await fastify.coordinatorStore.getProjection<WalletSessionRecord>(WALLET_SESSION, token),
        token,
      );
      return ok({ session });
    },
  );

  fastify.delete(
    "/wallet/session",
    {
      ...authPolicy("public-read", {
        tags: ["Wallet"],
        summary: "Revoke current wallet session by token",
        response: {
          200: envelope({
            type: "object",
            required: ["session"],
            properties: {
              session: {
                anyOf: [
                  {
                    type: "object",
                    required: ["token", "ecosystem", "address", "expiresAt", "principalBindings", "agentBindings", "capabilityHints"],
                    properties: {
                      token: { type: "string" },
                      ecosystem: { type: "string" },
                      address: { type: "string" },
                      chainId: { type: "string" },
                      requestedPrincipalId: { type: "string" },
                      principalBindings: { type: "array", items: { type: "string" } },
                      agentBindings: { type: "array", items: { type: "string" } },
                      capabilityHints: { type: "array", items: { type: "string" } },
                      createdAt: { type: "string" },
                      expiresAt: { type: "string" },
                      revokedAt: { type: "string" },
                    },
                  },
                  { type: "null" },
                ],
              },
            },
          }),
        },
      }),
    },
    async (request) => {
      const token = sessionTokenFromRequest(request.headers as Record<string, string | string[] | undefined>);
      if (!token) {
        return ok({ session: null });
      }
      const existing = await fastify.coordinatorStore.getProjection<WalletSessionRecord>(WALLET_SESSION, token);
      const session = ensureActiveWalletSession(existing, token);
      const revoked: WalletSessionRecord = {
        ...session,
        revokedAt: new Date().toISOString(),
      };
      await fastify.coordinatorStore.saveProjection(WALLET_SESSION, token, revoked);
      return ok({ session: revoked });
    },
  );
};

export default walletRoutes;
