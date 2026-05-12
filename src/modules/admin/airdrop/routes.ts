import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../../domain/apiTypes.js";
import { envelopeKey, listEnvelope } from "../../../domain/schemas.js";
import { AIRDROP_ELIGIBILITY, normalizeEvmAddress, type AirdropEligibility } from "../../identity/onboarding/domain.js";

const adminAirdropRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.put<{
    Params: { evmAddress: string };
    Body: { rootAmount: string; agentRegistrarAmount: string; enabled?: boolean; metadata?: Record<string, unknown> };
  }>(
    "/admin/airdrop/eligibility/:evmAddress",
    {
      schema: {
        tags: ["Admin"],
        summary: "Upsert airdrop eligibility for an EVM address",
        params: { type: "object", required: ["evmAddress"], properties: { evmAddress: { type: "string" } } },
        body: {
          type: "object",
          required: ["rootAmount", "agentRegistrarAmount"],
          properties: {
            rootAmount: { type: "string" },
            agentRegistrarAmount: { type: "string" },
            enabled: { type: "boolean" },
            metadata: { type: "object" },
          },
        },
        response: { 200: envelopeKey("eligibility") },
      },
    },
    async (request) => {
      const evmAddress = normalizeEvmAddress(request.params.evmAddress);
      const eligibility: AirdropEligibility = {
        evmAddress,
        rootAmount: request.body.rootAmount,
        agentRegistrarAmount: request.body.agentRegistrarAmount,
        enabled: request.body.enabled ?? true,
        metadata: request.body.metadata,
        updatedAt: new Date().toISOString(),
      };
      await fastify.coordinatorStore.saveProjection(AIRDROP_ELIGIBILITY, evmAddress, eligibility);
      return ok({ eligibility });
    },
  );

  fastify.get(
    "/admin/airdrop/eligibility",
    {
      schema: {
        tags: ["Admin"],
        summary: "List airdrop eligibility records",
        response: { 200: listEnvelope() },
      },
    },
    async () => {
      const rows = await fastify.coordinatorStore.listProjections<AirdropEligibility>(AIRDROP_ELIGIBILITY);
      return okList(rows, { limit: rows.length, nextCursor: null });
    },
  );
};

export default adminAirdropRoutes;
