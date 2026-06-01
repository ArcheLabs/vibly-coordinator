/**
 * Agent profile routes — GET /agent-profiles and GET /agent-profiles/:id.
 * All writes go through POST /action-intents (RegisterPrincipal, UpdateAgentProfile).
 */

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { CoordinatorConfig } from "../../config/env.js";
import { ok } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";
import { envelopeKey, envelopeKeyArray } from "../../domain/schemas.js";
import { IdentityRepository } from "../../contexts/identity/repository.js";
import { CoordinationRepository } from "../../contexts/coordination/repository.js";
import { ReviewRepository } from "../../contexts/evaluation/repository.js";
import { WorkRepository } from "../../contexts/work/repository.js";
import { SettlementRepository } from "../../contexts/settlement/repository.js";
import { StakeRepository } from "../../contexts/stake/repository.js";
import { authPolicy } from "../../plugins/authPolicy.js";
import type { AgentProfile } from "../../contexts/identity/types.js";

const ITEM_SCHEMA = { type: "object" as const, additionalProperties: true };
const NOTIFICATION_KIND = "agent_notification_v2";
const KNOWLEDGE_KIND = "knowledge_entry_v2";

function activeNetworkId(config: CoordinatorConfig, request: FastifyRequest): string {
  const header = request.headers["x-vibly-network-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return value && /^[a-zA-Z0-9:_./-]{1,128}$/.test(value) ? value : config.substrateChainId;
}

function agentMatchesNetwork(agent: AgentProfile, networkId: string, defaultNetworkId: string): boolean {
  return agent.chainId ? agent.chainId === networkId : networkId === defaultNetworkId;
}

const agentProfileRoutes: FastifyPluginAsync = async (fastify) => {
  const repo = () => new IdentityRepository(fastify.coordinatorStore);
  const stakeRepo = () => new StakeRepository(fastify.coordinatorStore);

  fastify.get<{ Params: { id: string } }>(
    "/agent-profiles/:id",
    {
      ...authPolicy("public-read", {
        tags: ["Agents"],
        summary: "Get agent profile by principal ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("agent") },
      }),
    },
    async (req) => {
      const profile = await repo().getAgentProfile(req.params.id);
      if (!profile) throw notFound("AgentProfile", req.params.id);
      if (!agentMatchesNetwork(profile, activeNetworkId(fastify.config, req), fastify.config.substrateChainId)) {
        throw notFound("AgentProfile", req.params.id);
      }
      const stakeLedger = await stakeRepo().getLedgerForProfile(profile);
      return ok({ agent: { ...profile, stakeLedger } });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; chainId?: string; limit?: number } }>(
    "/agent-profiles",
    {
      ...authPolicy("public-read", {
        tags: ["Agents"],
        summary: "List agent profiles",
        querystring: {
          type: "object",
          properties: {
            organizationId: { type: "string" },
            chainId: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      const all = await repo().listAgentProfiles();
      const networkId = req.query.chainId ?? activeNetworkId(fastify.config, req);
      let items = all.filter((agent) => agentMatchesNetwork(agent, networkId, fastify.config.substrateChainId));
      if (req.query.organizationId) items = items.filter((agent) => agent.organizationIds.includes(req.query.organizationId!));
      const page = await Promise.all(items.slice(0, req.query.limit ?? 50).map(async (agent) => ({
        ...agent,
        stakeLedger: await stakeRepo().getLedgerForProfile(agent),
      })));
      return ok({ items: page });
    },
  );

  fastify.get<{ Querystring: { principalId?: string; chainId?: string; status?: string; limit?: number } }>(
    "/agent-stakes",
    {
      ...authPolicy("public-read", {
        tags: ["Agents"],
        summary: "List agent stake ledgers synced from chain indexer",
        querystring: {
          type: "object",
          properties: {
            principalId: { type: "string" },
            chainId: { type: "string" },
            status: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      let items = await stakeRepo().listLedgers();
      if (req.query.principalId) items = items.filter((item) => item.principalId === req.query.principalId);
      if (req.query.chainId) items = items.filter((item) => item.chainId === req.query.chainId);
      if (req.query.status) items = items.filter((item) => item.status === req.query.status);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  fastify.get(
    "/agent-stake-indexer-health",
    {
      ...authPolicy("public-read", {
        tags: ["Agents"],
        summary: "Get agent stake indexer health",
        response: { 200: envelopeKey("health") },
      }),
    },
    async () => {
      return ok({ health: await stakeRepo().getIndexerHealth() });
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: { organizationId?: string; projectId?: string; limit?: number } }>(
    "/agents/:id/inbox",
    {
      ...authPolicy("wallet-session", {
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
      }),
    },
    async (req) => {
      const principalId = req.params.id;
      const limit = req.query.limit ?? 50;
      const coordination = new CoordinationRepository(fastify.coordinatorStore);
      const reviews = new ReviewRepository(fastify.coordinatorStore);
      const work = new WorkRepository(fastify.coordinatorStore);
      const settlement = new SettlementRepository(fastify.coordinatorStore);
      const profile = await repo().getAgentProfile(principalId);
      const stakeLedger = profile ? await stakeRepo().getLedgerForProfile(profile) : undefined;

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
          agent: profile ? { ...profile, stakeLedger } : undefined,
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

  fastify.post<{
    Params: { id: string };
    Body: {
      clientVersion?: string;
      daemonVersion?: string;
      contractVersion?: string;
      protocolVersion?: string;
      availability?: string;
      upgradePhase?: string;
      metadata?: Record<string, unknown>;
    };
  }>(
    "/agents/:id/heartbeat",
    {
      ...authPolicy("wallet-session", {
        tags: ["Agents"],
        summary: "Record an agent daemon heartbeat",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            clientVersion: { type: "string" },
            daemonVersion: { type: "string" },
            contractVersion: { type: "string" },
            protocolVersion: { type: "string" },
            availability: { type: "string" },
            upgradePhase: { type: "string" },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        response: { 200: envelopeKey("heartbeat", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      const now = new Date().toISOString();
      const heartbeat = {
        agentId: req.params.id,
        lastSeenAt: now,
        clientVersion: req.body?.clientVersion,
        daemonVersion: req.body?.daemonVersion,
        contractVersion: req.body?.contractVersion,
        protocolVersion: req.body?.protocolVersion,
        availability: req.body?.availability ?? "unknown",
        upgradePhase: req.body?.upgradePhase,
        metadata: req.body?.metadata ?? {},
      };
      await fastify.coordinatorStore.saveProjection("agent_heartbeat_v1", req.params.id, heartbeat);
      return ok({ heartbeat });
    },
  );

};

export default agentProfileRoutes;
