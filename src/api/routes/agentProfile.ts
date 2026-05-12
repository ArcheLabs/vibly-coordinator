/**
 * Agent profile routes — GET /agent-profiles and GET /agent-profiles/:id.
 * All writes go through POST /action-intents (RegisterPrincipal, UpdateAgentProfile).
 */

import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";
import { envelopeKey, envelopeKeyArray } from "../../domain/schemas.js";
import { IdentityRepository } from "../../contexts/identity/repository.js";
import { CoordinationRepository } from "../../contexts/coordination/repository.js";
import { ReviewRepository } from "../../contexts/evaluation/repository.js";
import { WorkRepository } from "../../contexts/work/repository.js";
import { SettlementRepository } from "../../contexts/settlement/repository.js";

const ITEM_SCHEMA = { type: "object" as const, additionalProperties: true };
const NOTIFICATION_KIND = "agent_notification_v2";
const KNOWLEDGE_KIND = "knowledge_entry_v2";

const agentProfileRoutes: FastifyPluginAsync = async (fastify) => {
  const repo = () => new IdentityRepository(fastify.coordinatorStore);

  fastify.get<{ Params: { id: string } }>(
    "/agent-profiles/:id",
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
    "/agent-profiles",
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
      const items = req.query.organizationId ? all.filter((agent) => agent.organizationIds.includes(req.query.organizationId!)) : all;
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: { organizationId?: string; projectId?: string; limit?: number } }>(
    "/agents/:id/inbox",
    {
      schema: {
        tags: ["Agents"],
        summary: "Get agent-facing inbox items and readable project snapshot",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        querystring: {
          type: "object",
          properties: {
            organizationId: { type: "string" },
            projectId: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: {
          200: envelopeKey("inbox", {
            type: "object",
            additionalProperties: true,
          }),
        },
      },
    },
    async (req) => {
      const principalId = req.params.id;
      const limit = req.query.limit ?? 50;
      const coordination = new CoordinationRepository(fastify.coordinatorStore);
      const reviews = new ReviewRepository(fastify.coordinatorStore);
      const work = new WorkRepository(fastify.coordinatorStore);
      const settlement = new SettlementRepository(fastify.coordinatorStore);

      const assignmentOffersWithTasks = await Promise.all(
        (await coordination.listAssignmentOffersForPrincipal(principalId)).map(async (offer) => ({
          ...offer,
          observationTask: await coordination.getObservationTask(offer.observationTaskId),
        })),
      );
      const assignmentOffers = assignmentOffersWithTasks
        .filter((item) => !req.query.organizationId || item.observationTask?.organizationId === req.query.organizationId)
        .filter((item) => !req.query.projectId || item.observationTask?.projectId === req.query.projectId)
        .slice(0, limit);

      const discussions = (await coordination.listDiscussions(req.query.organizationId))
        .filter((discussion) => {
          if (req.query.projectId && discussion.projectId !== req.query.projectId) return false;
          return discussion.status === "open" && discussion.rounds.some((round) => round.participantIds.includes(principalId));
        })
        .slice(0, limit);

      const reviewRequests = (await reviews.list(req.query.organizationId))
        .filter((round) => {
          if (!round.reviewerIds.includes(principalId)) return false;
          if (round.reviews.some((review) => review.reviewerId === principalId)) return false;
          return round.status === "pending" || round.status === "in-review";
        })
        .slice(0, limit);

      const availableTasks = (await work.listTasks(req.query.organizationId))
        .filter((task) => {
          if (req.query.projectId && task.projectId !== req.query.projectId) return false;
          return task.status === "available" || task.assigneeId === principalId;
        })
        .slice(0, limit);

      const notifications = (await fastify.coordinatorStore.listProjections<Record<string, unknown>>(NOTIFICATION_KIND))
        .filter((item) => item["principalId"] === principalId)
        .filter((item) => !req.query.organizationId || item["organizationId"] === req.query.organizationId)
        .filter((item) => !req.query.projectId || item["projectId"] === req.query.projectId)
        .slice(0, limit);

      const knowledgeEntries = (await fastify.coordinatorStore.listProjections<Record<string, unknown>>(KNOWLEDGE_KIND))
        .filter((item) => !req.query.organizationId || item["organizationId"] === req.query.organizationId)
        .filter((item) => !req.query.projectId || item["projectId"] === req.query.projectId)
        .slice(0, limit);

      const rewardIntents = (await settlement.listRewardIntents(req.query.organizationId))
        .filter((reward) => reward.recipientId === principalId)
        .slice(0, limit);

      return ok({
        inbox: {
          principalId,
          assignmentOffers,
          discussionParticipations: discussions,
          reviewRequests,
          availableTasks,
          notifications,
          knowledgeSnapshot: {
            entries: knowledgeEntries,
            version: knowledgeEntries.length,
          },
          rewardIntents,
        },
      });
    },
  );
};

export default agentProfileRoutes;
