import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../../domain/apiTypes.js";
import { envelopeKey } from "../../../domain/schemas.js";
import { badRequest, conflict, notFound } from "../../../domain/errors.js";
import { authPolicy } from "../../../plugins/authPolicy.js";
import { WALLET_SESSION, ensureActiveWalletSession, type WalletSessionRecord } from "../wallet/domain.js";
import {
  AIRDROP_CLAIM,
  AIRDROP_ELIGIBILITY,
  AIRDROP_PAYLOAD,
  IDENTITY_EVM_LINK,
  IDENTITY_EVM_UNLINK,
  IDENTITY_STATUS,
  ROOT_ROTATION,
  ROOT_ROTATION_PAYLOAD,
  buildSigningPayload,
  makeId,
  normalizeEvmAddress,
  verifyStoredPayload,
  type AirdropClaimRecord,
  type AirdropEligibility,
  type EvmAddressLinkRecord,
  type EvmAddressUnlinkRecord,
  type IdentityStatusRecord,
  type RootRotationRecord,
} from "./domain.js";


function sessionTokenFromRequest(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers["x-wallet-session"];
  if (!raw) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

async function requireEvmWalletSession(
  fastify: Parameters<FastifyPluginAsync>[0],
  headers: Record<string, string | string[] | undefined>,
  evmAddress: string,
): Promise<WalletSessionRecord> {
  const token = sessionTokenFromRequest(headers);
  if (!token) throw badRequest("Wallet session is required");
  const session = ensureActiveWalletSession(
    await fastify.coordinatorStore.getProjection<WalletSessionRecord>(WALLET_SESSION, token),
    token,
  );
  if (session.ecosystem !== "evm") throw badRequest("EVM wallet session is required", { ecosystem: session.ecosystem });
  const normalized = normalizeEvmAddress(evmAddress);
  if (session.address.toLowerCase() !== normalized) {
    throw badRequest("EVM address must match the wallet session", { evmAddress: normalized });
  }
  return session;
}

const onboardingRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.post<{ Body: { evmAddress: string; viblyAccountId: string; substrateAddress?: string } }>(
    "/identity/link-evm",
    {
      ...authPolicy("wallet-session", {
        tags: ["Identity"],
        summary: "Link an EVM address to the current Vibly identity",
        body: {
          type: "object",
          required: ["evmAddress", "viblyAccountId"],
          properties: {
            evmAddress: { type: "string" },
            viblyAccountId: { type: "string" },
            substrateAddress: { type: "string" },
          },
        },
        response: { 200: envelopeKey("link") },
      }),
    },
    async (request) => {
      const evmAddress = normalizeEvmAddress(request.body.evmAddress);
      await requireEvmWalletSession(fastify, request.headers as Record<string, string | string[] | undefined>, evmAddress);
      const now = new Date().toISOString();
      const existing = await fastify.coordinatorStore.getProjection<EvmAddressLinkRecord>(IDENTITY_EVM_LINK, evmAddress);
      if (existing && existing.viblyAccountId !== request.body.viblyAccountId) {
        throw conflict("EVM address is already linked to a different Vibly identity", { evmAddress });
      }
      const link: EvmAddressLinkRecord = existing ?? {
        id: makeId("evmlink"),
        evmAddress,
        viblyAccountId: request.body.viblyAccountId,
        substrateAddress: request.body.substrateAddress,
        status: "pending",
        chainSubmissionId: makeId("chain"),
        createdAt: now,
        updatedAt: now,
      };
      const next = {
        ...link,
        substrateAddress: request.body.substrateAddress ?? link.substrateAddress,
        updatedAt: now,
      } satisfies EvmAddressLinkRecord;
      await fastify.coordinatorStore.saveProjection(IDENTITY_EVM_LINK, evmAddress, next);
      await fastify.coordinatorStore.saveProjection(IDENTITY_STATUS, evmAddress, {
        evmAddress,
        identityId: request.body.viblyAccountId,
        viblyRootAddress: request.body.viblyAccountId,
        status: "pending",
        updatedAt: now,
      } satisfies IdentityStatusRecord);
      return ok({ link: next });
    },
  );

  fastify.post<{ Body: { evmAddress: string; viblyAccountId?: string } }>(
    "/identity/unlink-evm",
    {
      ...authPolicy("wallet-session", {
        tags: ["Identity"],
        summary: "Unlink an EVM address from the current Vibly identity",
        body: {
          type: "object",
          required: ["evmAddress"],
          properties: {
            evmAddress: { type: "string" },
            viblyAccountId: { type: "string" },
          },
        },
        response: { 200: envelopeKey("unlink") },
      }),
    },
    async (request) => {
      const evmAddress = normalizeEvmAddress(request.body.evmAddress);
      await requireEvmWalletSession(fastify, request.headers as Record<string, string | string[] | undefined>, evmAddress);
      const existing = await fastify.coordinatorStore.getProjection<EvmAddressLinkRecord>(IDENTITY_EVM_LINK, evmAddress);
      if (!existing) throw notFound("EVM address link", evmAddress);
      if (request.body.viblyAccountId && existing.viblyAccountId !== request.body.viblyAccountId) {
        throw badRequest("Vibly identity does not match existing EVM link", { evmAddress });
      }
      const now = new Date().toISOString();
      const unlink: EvmAddressUnlinkRecord = {
        id: makeId("evmunlink"),
        evmAddress,
        viblyAccountId: existing.viblyAccountId,
        status: "pending",
        chainSubmissionId: makeId("chain"),
        createdAt: now,
        updatedAt: now,
      };
      await fastify.coordinatorStore.saveProjection(IDENTITY_EVM_UNLINK, unlink.id, unlink);
      await fastify.coordinatorStore.deleteProjection(IDENTITY_EVM_LINK, evmAddress);
      await fastify.coordinatorStore.deleteProjection(IDENTITY_STATUS, evmAddress);
      return ok({ unlink });
    },
  );

  fastify.post<{ Body: { evmAddress: string; viblyRootAddress: string; agentRegistrarAddress: string } }>(
    "/identity/airdrop/payload",
    {
      schema: {
        tags: ["Identity"],
        summary: "Create an EVM signing payload for an airdrop claim",
        body: {
          type: "object",
          required: ["evmAddress", "viblyRootAddress", "agentRegistrarAddress"],
          properties: {
            evmAddress: { type: "string" },
            viblyRootAddress: { type: "string" },
            agentRegistrarAddress: { type: "string" },
          },
        },
        response: { 200: envelopeKey("signingPayload") },
      },
    },
    async (request) => {
      const evmAddress = normalizeEvmAddress(request.body.evmAddress);
      const record = buildSigningPayload({
        config: fastify.config,
        action: "airdrop_claim",
        evmAddress,
        viblyRootAddress: request.body.viblyRootAddress,
        agentRegistrarAddress: request.body.agentRegistrarAddress,
      });
      await fastify.coordinatorStore.saveProjection(AIRDROP_PAYLOAD, record.nonce, record);
      return ok({ signingPayload: record });
    },
  );

  fastify.post<{
    Body: {
      evmAddress: string;
      nonce: string;
      signature: string;
      viblyRootAddress: string;
      agentRegistrarAddress: string;
    };
  }>(
    "/identity/airdrop/claim",
    {
      schema: {
        tags: ["Identity"],
        summary: "Submit a signed EVM airdrop claim",
        body: {
          type: "object",
          required: ["evmAddress", "nonce", "signature", "viblyRootAddress", "agentRegistrarAddress"],
          properties: {
            evmAddress: { type: "string" },
            nonce: { type: "string" },
            signature: { type: "string" },
            viblyRootAddress: { type: "string" },
            agentRegistrarAddress: { type: "string" },
          },
        },
        response: { 200: envelopeKey("claim") },
      },
    },
    async (request) => {
      const evmAddress = normalizeEvmAddress(request.body.evmAddress);
      const existingClaim = await fastify.coordinatorStore.getProjection<AirdropClaimRecord>(AIRDROP_CLAIM, evmAddress);
      if (existingClaim) throw conflict("Airdrop already claimed", { evmAddress, claimId: existingClaim.id });
      const eligibility = await fastify.coordinatorStore.getProjection<AirdropEligibility>(AIRDROP_ELIGIBILITY, evmAddress);
      if (!eligibility || !eligibility.enabled) throw notFound("Airdrop eligibility", evmAddress);
      const payload = await verifyStoredPayload({
        store: fastify.coordinatorStore,
        kind: AIRDROP_PAYLOAD,
        nonce: request.body.nonce,
        evmAddress,
        signature: request.body.signature,
      });
      if (payload.viblyRootAddress !== request.body.viblyRootAddress || payload.agentRegistrarAddress !== request.body.agentRegistrarAddress) {
        throw badRequest("Claim addresses do not match signing payload");
      }
      const now = new Date().toISOString();
      const claim: AirdropClaimRecord = {
        id: makeId("claim"),
        evmAddress,
        viblyRootAddress: request.body.viblyRootAddress,
        agentRegistrarAddress: request.body.agentRegistrarAddress,
        rootAmount: eligibility.rootAmount,
        agentRegistrarAmount: eligibility.agentRegistrarAmount,
        status: "submitted",
        chainSubmissionId: makeId("chain"),
        createdAt: now,
        updatedAt: now,
      };
      await fastify.coordinatorStore.saveProjection(AIRDROP_CLAIM, evmAddress, claim);
      await fastify.coordinatorStore.saveProjection(IDENTITY_STATUS, evmAddress, {
        evmAddress,
        viblyRootAddress: claim.viblyRootAddress,
        agentRegistrarAddress: claim.agentRegistrarAddress,
        airdropClaimId: claim.id,
        status: "pending",
        updatedAt: now,
      } satisfies IdentityStatusRecord);
      return ok({ claim });
    },
  );

  fastify.get<{ Params: { evmAddress: string } }>(
    "/identity/airdrop/status/:evmAddress",
    {
      schema: {
        tags: ["Identity"],
        summary: "Get airdrop claim status for an EVM address",
        params: { type: "object", required: ["evmAddress"], properties: { evmAddress: { type: "string" } } },
        response: { 200: envelopeKey("claim") },
      },
    },
    async (request) => {
      const evmAddress = normalizeEvmAddress(request.params.evmAddress);
      const claim = await fastify.coordinatorStore.getProjection<AirdropClaimRecord>(AIRDROP_CLAIM, evmAddress);
      if (!claim) throw notFound("Airdrop claim", evmAddress);
      return ok({ claim });
    },
  );

  fastify.post<{ Body: { evmAddress: string; newRootAddress: string } }>(
    "/identity/root-rotation/payload",
    {
      schema: {
        tags: ["Identity"],
        summary: "Create an EVM signing payload for root rotation",
        body: {
          type: "object",
          required: ["evmAddress", "newRootAddress"],
          properties: { evmAddress: { type: "string" }, newRootAddress: { type: "string" } },
        },
        response: { 200: envelopeKey("signingPayload") },
      },
    },
    async (request) => {
      const evmAddress = normalizeEvmAddress(request.body.evmAddress);
      const record = buildSigningPayload({
        config: fastify.config,
        action: "root_rotation",
        evmAddress,
        viblyRootAddress: request.body.newRootAddress,
      });
      await fastify.coordinatorStore.saveProjection(ROOT_ROTATION_PAYLOAD, record.nonce, record);
      return ok({ signingPayload: record });
    },
  );

  fastify.post<{ Body: { evmAddress: string; nonce: string; signature: string; newRootAddress: string } }>(
    "/identity/root-rotation/submit",
    {
      schema: {
        tags: ["Identity"],
        summary: "Submit a signed EVM root rotation",
        body: {
          type: "object",
          required: ["evmAddress", "nonce", "signature", "newRootAddress"],
          properties: {
            evmAddress: { type: "string" },
            nonce: { type: "string" },
            signature: { type: "string" },
            newRootAddress: { type: "string" },
          },
        },
        response: { 200: envelopeKey("rootRotation") },
      },
    },
    async (request) => {
      const evmAddress = normalizeEvmAddress(request.body.evmAddress);
      const identity = await fastify.coordinatorStore.getProjection<IdentityStatusRecord>(IDENTITY_STATUS, evmAddress);
      if (!identity) throw notFound("Identity", evmAddress);
      const payload = await verifyStoredPayload({
        store: fastify.coordinatorStore,
        kind: ROOT_ROTATION_PAYLOAD,
        nonce: request.body.nonce,
        evmAddress,
        signature: request.body.signature,
      });
      if (payload.viblyRootAddress !== request.body.newRootAddress) throw badRequest("Root rotation target does not match signing payload");
      const now = new Date().toISOString();
      const rootRotation: RootRotationRecord = {
        id: makeId("rotation"),
        evmAddress,
        previousRootAddress: identity.viblyRootAddress,
        newRootAddress: request.body.newRootAddress,
        status: "submitted",
        chainSubmissionId: makeId("chain"),
        createdAt: now,
        updatedAt: now,
      };
      await fastify.coordinatorStore.saveProjection(ROOT_ROTATION, rootRotation.id, rootRotation);
      await fastify.coordinatorStore.saveProjection(IDENTITY_STATUS, evmAddress, {
        ...identity,
        viblyRootAddress: request.body.newRootAddress,
        updatedAt: now,
      });
      return ok({ rootRotation });
    },
  );

  fastify.get<{ Params: { evmAddress: string } }>(
    "/identity/status/evm/:evmAddress",
    {
      schema: {
        tags: ["Identity"],
        summary: "Get identity status by EVM address",
        params: { type: "object", required: ["evmAddress"], properties: { evmAddress: { type: "string" } } },
        response: { 200: envelopeKey("identity") },
      },
    },
    async (request) => {
      const evmAddress = normalizeEvmAddress(request.params.evmAddress);
      const identity = await fastify.coordinatorStore.getProjection<IdentityStatusRecord>(IDENTITY_STATUS, evmAddress);
      if (!identity) throw notFound("Identity", evmAddress);
      return ok({ identity });
    },
  );
};

export default onboardingRoutes;
