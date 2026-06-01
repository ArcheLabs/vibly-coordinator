import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { envelopeKey, listEnvelope } from "../../../domain/schemas.js";
import type { ActionIntent } from "@vibly-ai/concord-core";

const actionsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /actions
  fastify.post<{
    Body: {
      projectId?: string;
      objectiveId?: string;
      type: string;
      proposedBy: string;
      goalId: string;
      title: string;
      description?: string;
      riskLevel?: string;
      contextBundleId?: string;
      inputs?: unknown[];
    };
  }>(
    "/actions",
    {
      schema: {
        tags: ["Actions"],
        summary: "Propose an action",
        body: {
          type: "object",
          required: ["type", "proposedBy", "goalId", "title"],
          properties: {
            projectId: { type: "string" },
            objectiveId: { type: "string" },
            type: { type: "string", minLength: 1 },
            proposedBy: { type: "string" },
            goalId: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            riskLevel: { type: "string" },
            contextBundleId: { type: "string" },
            inputs: { type: "array" },
          },
        },
        response: { 200: envelopeKey("action") },
      },
    },
    async (request) => {
      const contextBundle = request.body.contextBundleId
        ? await fastify.concord.context.getBundle(request.body.contextBundleId)
        : null;

      const action = await fastify.concord.actions.propose({
        projectId: request.body.projectId as never,
        objectiveId: request.body.objectiveId as never,
        type: request.body.type,
        proposedBy: request.body.proposedBy as never,
        goalId: request.body.goalId as never,
        title: request.body.title,
        description: request.body.description ?? "",
        riskLevel: (request.body.riskLevel ?? "low") as never,
        context: contextBundle as never,
        inputs: (request.body.inputs ?? []) as never,
        expectedOutputs: [],
      });
      const events = await fastify.concord.state.events.query({ type: ["ActionProposed"] });
      const evt = events.find((e) => (e.payload as { id?: string })?.id === action.id);
      if (evt) fastify.eventBus.publish(evt);
      return ok({ action });
    },
  );

  // GET /actions/:actionId
  fastify.get<{ Params: { actionId: string } }>(
    "/actions/:actionId",
    {
      schema: {
        tags: ["Actions"],
        summary: "Get an action",
        params: { type: "object", required: ["actionId"], properties: { actionId: { type: "string" } } },
        response: { 200: envelopeKey("action") },
      },
    },
    async (request) => {
      const action = await fastify.concord.actions.get(request.params.actionId as never);
      if (!action) throw notFound("Action", request.params.actionId);
      return ok({ action });
    },
  );

  // GET /projects/:projectId/actions
  fastify.get<{
    Params: { projectId: string };
    Querystring: { type?: string; proposedBy?: string; limit?: string; cursor?: string };
  }>(
    "/projects/:projectId/actions",
    {
      schema: {
        tags: ["Actions"],
        summary: "List actions for a project",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        querystring: {
          type: "object",
          properties: {
            type: { type: "string" },
            proposedBy: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: { 200: listEnvelope() },
      },
    },
    async (request) => {
      const { type, proposedBy, limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);
      const events = await fastify.concord.state.events.query({ type: ["ActionProposed"] });
      let actions = events
        .map((e) => e.payload as ActionIntent)
        .filter((a) => (a as unknown as { projectId?: string }).projectId === request.params.projectId);
      if (type) actions = actions.filter((a) => a.type === type);
      if (proposedBy) actions = actions.filter((a) => String((a as unknown as { proposedBy?: string }).proposedBy) === proposedBy);

      let startIdx = 0;
      if (cursor) {
        const idx = actions.findIndex((a) => a.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = actions.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // POST /actions/:actionId/evaluate
  fastify.post<{
    Params: { actionId: string };
    Body: { actorId: string; contextBundleId: string };
  }>(
    "/actions/:actionId/evaluate",
    {
      schema: {
        tags: ["Actions"],
        summary: "Evaluate action against policies",
        params: { type: "object", required: ["actionId"], properties: { actionId: { type: "string" } } },
        body: {
          type: "object",
          required: ["actorId", "contextBundleId"],
          properties: {
            actorId: { type: "string" },
            contextBundleId: { type: "string" },
          },
        },
        response: { 200: envelopeKey("policyDecision") },
      },
    },
    async (request) => {
      const action = await fastify.concord.actions.get(request.params.actionId as never);
      if (!action) throw notFound("Action", request.params.actionId);

      const actor = await fastify.concord.actors.get(request.body.actorId as never);
      if (!actor) throw notFound("Actor", request.body.actorId);

      const context = await fastify.concord.context.getBundle(request.body.contextBundleId);
      if (!context) throw notFound("ContextBundle", request.body.contextBundleId);

      const policyDecision = await fastify.concord.actions.evaluate({ action, actor, context });
      return ok({ policyDecision });
    },
  );
};

export default actionsRoutes;
