/**
 * Reputation read-model routes — reputation events and agent scores.
 * All writes happen automatically via the ReputationProjector.
 */

import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";
import { envelopeKey, envelopeKeyArray } from "../../domain/schemas.js";
import { ReputationRepository } from "../../contexts/reputation/repository.js";
import { authPolicy } from "../../plugins/authPolicy.js";
import { SettlementRepository } from "../../contexts/settlement/repository.js";

const ITEM_SCHEMA = { type: "object" as const, additionalProperties: true };

const reputationV2Routes: FastifyPluginAsync = async (fastify) => {
  const repRepo = () => new ReputationRepository(fastify.coordinatorStore);
  const settlRepo = () => new SettlementRepository(fastify.coordinatorStore);

  // ─── Reputation scores ────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string }; Querystring: { organizationId?: string } }>(
    "/agents/:id/reputation",
    {
      ...authPolicy("public-read", {
        tags: ["Reputation"],
        summary: "Get reputation score for an agent in an organization",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        querystring: { type: "object", properties: { organizationId: { type: "string" } } },
        response: { 200: envelopeKey("reputation") },
      }),
    },
    async (req) => {
      const { id } = req.params;
      const { organizationId } = req.query;
      if (!organizationId) {
        const scores = await repRepo().listScores();
        const forAgent = scores.filter((score) => score.principalId === id);
        return ok({ reputation: forAgent });
      }
      const score = await repRepo().getScore(organizationId, id);
      if (!score) throw notFound("AgentReputation", id);
      return ok({ reputation: score });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; limit?: number } }>(
    "/reputation",
    {
      ...authPolicy("public-read", {
        tags: ["Reputation"],
        summary: "List agent reputation scores",
        querystring: {
          type: "object",
          properties: {
            organizationId: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      const items = await repRepo().listScores(req.query.organizationId);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  // ─── Reputation events ────────────────────────────────────────────────────

  fastify.get<{ Querystring: { principalId?: string; organizationId?: string; limit?: number } }>(
    "/reputation/events",
    {
      ...authPolicy("public-read", {
        tags: ["Reputation"],
        summary: "List reputation events",
        querystring: {
          type: "object",
          properties: {
            principalId: { type: "string" },
            organizationId: { type: "string" },
            limit: { type: "integer", default: 100 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      const items = await repRepo().listEvents(req.query.principalId, req.query.organizationId);
      return ok({ items: items.slice(0, req.query.limit ?? 100) });
    },
  );

  // ─── Reward Intents ───────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    "/reward-intents/:id",
    {
      schema: {
        tags: ["Settlement"],
        summary: "Get reward intent by ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("rewardIntent") },
      },
    },
    async (req) => {
      const rewardIntent = await settlRepo().getRewardIntent(req.params.id);
      if (!rewardIntent) throw notFound("RewardIntent", req.params.id);
      return ok({ rewardIntent });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; status?: string; limit?: number } }>(
    "/reward-intents",
    {
      schema: {
        tags: ["Settlement"],
        summary: "List reward intents",
        querystring: {
          type: "object",
          properties: {
            organizationId: { type: "string" },
            status: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      },
    },
    async (req) => {
      const items = await settlRepo().listRewardIntents(
        req.query.organizationId,
        req.query.status as RewardIntent["status"] | undefined,
      );
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  // ─── Settlement Batches ───────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    "/settlement-batches/:id",
    {
      schema: {
        tags: ["Settlement"],
        summary: "Get settlement batch by ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("batch") },
      },
    },
    async (req) => {
      const batch = await settlRepo().getBatch(req.params.id);
      if (!batch) throw notFound("SettlementBatch", req.params.id);
      return ok({ batch });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; limit?: number } }>(
    "/settlement-batches",
    {
      schema: {
        tags: ["Settlement"],
        summary: "List settlement batches",
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
      const items = await settlRepo().listBatches(req.query.organizationId);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );
};

// Fix missing type import used in query handler
import type { RewardIntent } from "../../contexts/settlement/types.js";

export default reputationV2Routes;
