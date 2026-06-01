import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { envelope, envelopeKey, listEnvelope } from "../../../domain/schemas.js";
import { v4 as uuidv4 } from "uuid";
import { REWARD_INTENT } from "../../../db/projectionKinds.js";

interface RewardIntent {
  id: string;
  projectId?: string;
  workOrderId?: string;
  amount: string;
  currency: string;
  recipient: string;
  status: "draft" | "reserved" | "claimable" | "approved" | "claimed" | "cancelled";
  fundingReceipt?: unknown;
  settlementReceipt?: unknown;
  createdAt: string;
  updatedAt: string;
}

const incentivesRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /rewards
  fastify.get<{ Querystring: { projectId?: string; actorId?: string; status?: string; limit?: string; cursor?: string } }>(
    "/rewards",
    {
      schema: {
        tags: ["Incentives"],
        summary: "List reward intents",
        querystring: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            actorId: { type: "string" },
            status: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: { 200: listEnvelope() },
      },
    },
    async (request) => {
      const { projectId, status, limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);
      let intents = await fastify.coordinatorStore.listProjections<RewardIntent>(REWARD_INTENT);
      if (projectId) intents = intents.filter((r) => r.projectId === projectId);
      if (status) intents = intents.filter((r) => r.status === status);

      let startIdx = 0;
      if (cursor) {
        const idx = intents.findIndex((r) => r.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = intents.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // GET /rewards/:rewardIntentId
  fastify.get<{ Params: { rewardIntentId: string } }>(
    "/rewards/:rewardIntentId",
    {
      schema: {
        tags: ["Incentives"],
        summary: "Get a reward intent",
        params: { type: "object", required: ["rewardIntentId"], properties: { rewardIntentId: { type: "string" } } },
        response: { 200: envelopeKey("rewardIntent") },
      },
    },
    async (request) => {
      const intent = await fastify.coordinatorStore.getProjection<RewardIntent>(REWARD_INTENT, request.params.rewardIntentId);
      if (!intent) throw notFound("RewardIntent", request.params.rewardIntentId);
      return ok({ rewardIntent: intent });
    },
  );

  // Internal helper to create reward intent (called from work routes after WorkOrderCreated)
  // POST /rewards (create)
  fastify.post<{
    Body: { projectId?: string; workOrderId?: string; amount: string; currency: string; recipient: string };
  }>(
    "/rewards",
    {
      schema: {
        tags: ["Incentives"],
        summary: "Create a reward intent",
        body: {
          type: "object",
          required: ["amount", "currency", "recipient"],
          properties: {
            projectId: { type: "string" },
            workOrderId: { type: "string" },
            amount: { type: "string" },
            currency: { type: "string" },
            recipient: { type: "string" },
          },
        },
        response: { 200: envelopeKey("rewardIntent") },
      },
    },
    async (request) => {
      const now = new Date().toISOString();
      const intent: RewardIntent = {
        id: `reward_${uuidv4().replace(/-/g, "").slice(0, 16)}`,
        projectId: request.body.projectId,
        workOrderId: request.body.workOrderId,
        amount: request.body.amount,
        currency: request.body.currency,
        recipient: request.body.recipient,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };
      await fastify.coordinatorStore.saveProjection(REWARD_INTENT, intent.id, intent);

      const { createEvent } = await import("@vibly-ai/concord-foundation");
      const event = createEvent({ type: "RewardIntentCreated", payload: intent });
      await fastify.concord.state.events.append(event);
      fastify.eventBus.publish(event);

      return ok({ rewardIntent: intent });
    },
  );

  // POST /rewards/:rewardIntentId/reserve
  fastify.post<{ Params: { rewardIntentId: string } }>(
    "/rewards/:rewardIntentId/reserve",
    {
      schema: {
        tags: ["Incentives"],
        summary: "Mock reserve reward",
        params: { type: "object", required: ["rewardIntentId"], properties: { rewardIntentId: { type: "string" } } },
        response: { 200: envelope() },
      },
    },
    async (request) => {
      const intent = await fastify.coordinatorStore.getProjection<RewardIntent>(REWARD_INTENT, request.params.rewardIntentId);
      if (!intent) throw notFound("RewardIntent", request.params.rewardIntentId);

      const fundingReceipt = await fastify.concord.fundingGateway.reserve({
        amount: intent.amount,
        currency: intent.currency,
        recipient: intent.recipient,
        referenceId: intent.id,
      });

      const updated: RewardIntent = { ...intent, status: "reserved", fundingReceipt, updatedAt: new Date().toISOString() };
      await fastify.coordinatorStore.saveProjection(REWARD_INTENT, intent.id, updated);

      const { createEvent } = await import("@vibly-ai/concord-foundation");
      const event = createEvent({ type: "FundingReserved", payload: { projectId: updated.projectId, rewardIntentId: intent.id, fundingReceipt } });
      await fastify.concord.state.events.append(event);
      fastify.eventBus.publish(event);

      return ok({ rewardIntent: updated, fundingReceipt });
    },
  );

  // POST /rewards/:rewardIntentId/claim
  fastify.post<{
    Params: { rewardIntentId: string };
    Body: { actorId: string };
  }>(
    "/rewards/:rewardIntentId/claim",
    {
      schema: {
        tags: ["Incentives"],
        summary: "Mock claim reward",
        params: { type: "object", required: ["rewardIntentId"], properties: { rewardIntentId: { type: "string" } } },
        body: {
          type: "object",
          required: ["actorId"],
          properties: { actorId: { type: "string" } },
        },
        response: { 200: envelope() },
      },
    },
    async (request) => {
      const intent = await fastify.coordinatorStore.getProjection<RewardIntent>(REWARD_INTENT, request.params.rewardIntentId);
      if (!intent) throw notFound("RewardIntent", request.params.rewardIntentId);

      const settlementReceipt = await fastify.concord.fundingGateway.claim({
        referenceId: intent.id,
        actorId: request.body.actorId,
      });

      const updated: RewardIntent = { ...intent, status: "claimed", settlementReceipt, updatedAt: new Date().toISOString() };
      await fastify.coordinatorStore.saveProjection(REWARD_INTENT, intent.id, updated);

      const { createEvent } = await import("@vibly-ai/concord-foundation");
      const event = createEvent({ type: "RewardClaimed", payload: { projectId: updated.projectId, rewardIntentId: intent.id, settlementReceipt } });
      await fastify.concord.state.events.append(event);
      fastify.eventBus.publish(event);

      return ok({ rewardIntent: updated, settlementReceipt });
    },
  );

  // GET /ledger — mock ledger summary
  fastify.get(
    "/ledger",
    {
      schema: {
        tags: ["Incentives"],
        summary: "View mock ledger summary",
        response: { 200: envelope() },
      },
    },
    async () => {
      const intents = await fastify.coordinatorStore.listProjections<RewardIntent>(REWARD_INTENT);
      const summary = {
        total: intents.length,
        byStatus: {
          draft: intents.filter((r) => r.status === "draft").length,
          reserved: intents.filter((r) => r.status === "reserved").length,
          claimable: intents.filter((r) => r.status === "claimable" || r.status === "approved").length,
          approved: intents.filter((r) => r.status === "approved").length,
          claimed: intents.filter((r) => r.status === "claimed").length,
          cancelled: intents.filter((r) => r.status === "cancelled").length,
        },
        fundingReceipts: intents.filter((r) => r.fundingReceipt).slice(-10).map((r) => ({ rewardIntentId: r.id, receipt: r.fundingReceipt })),
        settlementReceipts: intents.filter((r) => r.settlementReceipt).slice(-10).map((r) => ({ rewardIntentId: r.id, receipt: r.settlementReceipt })),
        recentEntries: intents.slice(-10),
      };
      return ok(summary);
    },
  );
};

export default incentivesRoutes;
