/**
 * Agent profile routes — GET /agents and GET /agents/:id
 * All writes go through POST /action-intents (RegisterPrincipal, UpdateAgentProfile).
 */

import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";
import { envelopeKey, envelopeKeyArray } from "../../domain/schemas.js";
import { IdentityRepository } from "../../contexts/identity/repository.js";

const ITEM_SCHEMA = { type: "object" as const, additionalProperties: true };

const agentProfileRoutes: FastifyPluginAsync = async (fastify) => {
  const repo = () => new IdentityRepository(fastify.coordinatorStore);

  fastify.get<{ Params: { id: string } }>(
    "/agents/:id",
    {
      schema: {
        tags: ["Agents"],
        summary: "Get agent profile by principal ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("agent") },
      },
    },
    async (req) => {
      const profile = await repo().getAgentProfile(req.params.id);
      if (!profile) throw notFound("AgentProfile", req.params.id);
      return ok({ agent: profile });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; limit?: number } }>(
    "/agents",
    {
      schema: {
        tags: ["Agents"],
        summary: "List agent profiles",
        querystring: {
          type: "object",
          properties: {
            organizationId: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      },
    },
    async (req) => {
      const all = await repo().listAgentProfiles();
      const items = req.query.organizationId ? all : all;
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );
};

export default agentProfileRoutes;
