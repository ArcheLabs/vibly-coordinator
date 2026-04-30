import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";

const governanceRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /governance/intents
  fastify.post<{
    Body: {
      projectId?: string;
      kind: string;
      actionId?: string;
      decisionRecordId?: string;
      title: string;
      body?: string;
    };
  }>(
    "/governance/intents",
    {
      schema: {
        tags: ["Governance"],
        summary: "Create a governance intent",
        body: {
          type: "object",
          required: ["kind", "title"],
          properties: {
            projectId: { type: "string" },
            kind: { type: "string" },
            actionId: { type: "string" },
            decisionRecordId: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const { createEvent, makeId } = await import("@concord/foundation");
      const now = new Date().toISOString();
      const intent = {
        id: makeId("GovernanceIntentId"),
        projectId: request.body.projectId,
        kind: request.body.kind,
        actionId: request.body.actionId,
        decisionRecordId: request.body.decisionRecordId,
        title: request.body.title,
        body: request.body.body,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };
      fastify.coordinatorStore.saveProjection("governance_intent", String(intent.id), intent);
      const evt = createEvent({ type: "GovernanceIntentCreated", payload: intent });
      await fastify.concord.state.events.append(evt);
      fastify.eventBus.publish(evt);
      return ok({ governanceIntent: intent });
    },
  );

  // GET /governance/intents/:governanceIntentId
  fastify.get<{ Params: { governanceIntentId: string } }>(
    "/governance/intents/:governanceIntentId",
    {
      schema: {
        tags: ["Governance"],
        summary: "Get a governance intent",
        params: {
          type: "object",
          required: ["governanceIntentId"],
          properties: { governanceIntentId: { type: "string" } },
        },
      },
    },
    async (request) => {
      const intent = fastify.coordinatorStore.getProjection("governance_intent", request.params.governanceIntentId);
      if (!intent) throw notFound("GovernanceIntent", request.params.governanceIntentId);
      return ok({ governanceIntent: intent });
    },
  );

  // POST /governance/intents/:governanceIntentId/submit-mock
  fastify.post<{ Params: { governanceIntentId: string } }>(
    "/governance/intents/:governanceIntentId/submit-mock",
    {
      schema: {
        tags: ["Governance"],
        summary: "Mock submit governance intent (MockGovernanceGateway)",
        params: {
          type: "object",
          required: ["governanceIntentId"],
          properties: { governanceIntentId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const intent = fastify.coordinatorStore.getProjection<{
        id: string;
        kind: string;
        title: string;
        body?: string;
        status: string;
      }>("governance_intent", request.params.governanceIntentId);
      if (!intent) throw notFound("GovernanceIntent", request.params.governanceIntentId);

      // Call GovernanceGateway.submitProposal (which is MockGovernanceGateway in dev)
      const result = await fastify.concord.governanceGateway.submitProposal({
        kind: intent.kind,
        title: intent.title,
        body: intent.body ?? "",
        referenceId: intent.id,
      });

      const updated = { ...intent, status: "submitted", mockResult: result, updatedAt: new Date().toISOString() };
      fastify.coordinatorStore.saveProjection("governance_intent", intent.id, updated);

      const { createEvent } = await import("@concord/foundation");
      const evt = createEvent({ type: "GovernanceSubmittedMock", payload: { governanceIntentId: intent.id, result } });
      await fastify.concord.state.events.append(evt);
      fastify.eventBus.publish(evt);

      // Deprecated: use /governance/views for chain-indexed data
      void reply.header("Deprecation", "true");
      void reply.header("Sunset", "2026-12-31");

      return ok({ governanceIntent: updated, result });
    },
  );

  // ── GET /governance/views ─────────────────────────────────────────────────
  // List all governance views written by GovernanceIndexConsumer.
  fastify.get(
    "/governance/views",
    {
      schema: {
        tags: ["Governance"],
        summary: "List governance subject views (from chain indexer)",
      },
    },
    async () => {
      const items = fastify.coordinatorStore.listProjections("governance_view") as unknown[];
      return ok({ items });
    },
  );

  // ── GET /governance/views/:subjectId ──────────────────────────────────────
  fastify.get<{ Params: { subjectId: string } }>(
    "/governance/views/:subjectId",
    {
      schema: {
        tags: ["Governance"],
        summary: "Get a governance subject view by subjectId (chainId:referendumIndex)",
        params: {
          type: "object",
          required: ["subjectId"],
          properties: { subjectId: { type: "string" } },
        },
      },
    },
    async (request) => {
      const view = fastify.coordinatorStore.getProjection("governance_view", request.params.subjectId);
      if (!view) throw notFound("GovernanceView", request.params.subjectId);
      return ok({ view });
    },
  );

  // ── GET /governance/checkpoint ────────────────────────────────────────────
  // Returns the latest indexed block checkpoint from GovernanceIndexQueryPort.
  fastify.get(
    "/governance/checkpoint",
    {
      schema: {
        tags: ["Governance"],
        summary: "Get the latest governance index checkpoint",
      },
    },
    async () => {
      const indexQuery = fastify.concord.governanceIndexQuery;
      if (!indexQuery) {
        return ok({ checkpoint: null, note: "governanceIndexQuery not configured" });
      }
      const chainId = fastify.config.substrateChainId ?? "substrate:vibly-solo";
      const chain = { namespace: "substrate" as const, chainId };
      const checkpoint = await indexQuery.getGovernanceCheckpoint({ chain });
      return ok({ checkpoint });
    },
  );
};

export default governanceRoutes;
