import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { envelope, envelopeKey, listEnvelope } from "../../../domain/schemas.js";

const negotiationsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /negotiations
  fastify.post<{
    Body: {
      actionId: string;
      protocolId?: string;
      participantIds: string[];
      contextBundleId?: string;
    };
  }>(
    "/negotiations",
    {
      schema: {
        tags: ["Negotiations"],
        summary: "Create a negotiation",
        body: {
          type: "object",
          required: ["actionId", "participantIds"],
          properties: {
            actionId: { type: "string" },
            protocolId: { type: "string" },
            participantIds: { type: "array", items: { type: "string" } },
            contextBundleId: { type: "string" },
          },
        },
        response: { 200: envelopeKey("negotiation") },
      },
    },
    async (request) => {
      const action = await fastify.concord.actions.get(request.body.actionId as never);
      if (!action) throw notFound("Action", request.body.actionId);

      const participants = await Promise.all(
        request.body.participantIds.map((id) => fastify.concord.actors.get(id as never)),
      );
      const validParticipants = participants.filter(Boolean);

      let context: never;
      if (request.body.contextBundleId) {
        const bundle = await fastify.concord.context.getBundle(request.body.contextBundleId);
        if (!bundle) throw notFound("ContextBundle", request.body.contextBundleId);
        const { receiptFromBundle } = await import("@concord/adapters");
        context = receiptFromBundle(bundle, action.proposedBy) as never;
      } else {
        context = action.context as never;
      }

      const negotiation = await fastify.concord.negotiation.create({
        action,
        protocolId: request.body.protocolId ?? "delegate-fast-vote",
        participants: validParticipants as never,
        context,
      });
      fastify.eventBus.publish({ type: "NegotiationStarted", payload: negotiation } as never);
      return ok({ negotiation });
    },
  );

  // GET /negotiations/:negotiationId
  fastify.get<{ Params: { negotiationId: string } }>(
    "/negotiations/:negotiationId",
    {
      schema: {
        tags: ["Negotiations"],
        summary: "Get a negotiation",
        params: { type: "object", required: ["negotiationId"], properties: { negotiationId: { type: "string" } } },
        response: { 200: envelopeKey("negotiation") },
      },
    },
    async (request) => {
      const negotiation = await fastify.concord.negotiation.get(request.params.negotiationId as never);
      if (!negotiation) throw notFound("Negotiation", request.params.negotiationId);
      return ok({ negotiation });
    },
  );

  // GET /negotiations
  fastify.get<{ Querystring: { actionId?: string; status?: string; limit?: string; cursor?: string } }>(
    "/negotiations",
    {
      schema: {
        tags: ["Negotiations"],
        summary: "List negotiations",
        querystring: {
          type: "object",
          properties: {
            actionId: { type: "string" },
            status: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: { 200: listEnvelope() },
      },
    },
    async (request) => {
      const { actionId, status, limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);
      let negotiations = await fastify.concord.negotiation.list();
      if (actionId) negotiations = negotiations.filter((n) => n.actionId === actionId);
      if (status) negotiations = negotiations.filter((n) => n.status === status);

      let startIdx = 0;
      if (cursor) {
        const idx = negotiations.findIndex((n) => n.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = negotiations.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // POST /negotiations/:negotiationId/positions
  fastify.post<{
    Params: { negotiationId: string };
    Body: {
      actorId: string;
      stance: string;
      rationale: string;
      score?: number;
      proposedRevisions?: string[];
    };
  }>(
    "/negotiations/:negotiationId/positions",
    {
      schema: {
        tags: ["Negotiations"],
        summary: "Submit a position in a negotiation",
        params: { type: "object", required: ["negotiationId"], properties: { negotiationId: { type: "string" } } },
        body: {
          type: "object",
          required: ["actorId", "stance", "rationale"],
          properties: {
            actorId: { type: "string" },
            stance: { type: "string" },
            rationale: { type: "string" },
            score: { type: "number" },
            proposedRevisions: { type: "array", items: { type: "string" } },
          },
        },
        response: { 200: envelopeKey("negotiation") },
      },
    },
    async (request) => {
      const negotiation = await fastify.concord.negotiation.submitPosition({
        negotiationId: request.params.negotiationId as never,
        position: {
          actorId: request.body.actorId as never,
          stance: request.body.stance as never,
          rationale: request.body.rationale,
          score: request.body.score,
          evidence: [],
        },
      });
      return ok({ negotiation });
    },
  );

  // POST /negotiations/:negotiationId/delegate-vote
  fastify.post<{
    Params: { negotiationId: string };
    Body: {
      actorId: string;
      stance: string;
      rationale: string;
    };
  }>(
    "/negotiations/:negotiationId/delegate-vote",
    {
      schema: {
        tags: ["Negotiations"],
        summary: "Submit a delegate vote",
        params: { type: "object", required: ["negotiationId"], properties: { negotiationId: { type: "string" } } },
        body: {
          type: "object",
          required: ["actorId", "stance", "rationale"],
          properties: {
            actorId: { type: "string" },
            stance: { type: "string" },
            rationale: { type: "string" },
          },
        },
        response: { 200: envelopeKey("negotiation") },
      },
    },
    async (request) => {
      const negotiation = await fastify.concord.negotiation.submitPosition({
        negotiationId: request.params.negotiationId as never,
        position: {
          actorId: request.body.actorId as never,
          stance: request.body.stance as never,
          rationale: request.body.rationale,
          evidence: [],
        },
      });
      return ok({ negotiation });
    },
  );

  // POST /negotiations/:negotiationId/close
  fastify.post<{
    Params: { negotiationId: string };
    Body: { source?: string; projectId?: string };
  }>(
    "/negotiations/:negotiationId/close",
    {
      schema: {
        tags: ["Negotiations"],
        summary: "Close the current round. Returns decisionRecord + updated negotiation. If result is needs_revision, a new round is already opened.",
        params: { type: "object", required: ["negotiationId"], properties: { negotiationId: { type: "string" } } },
        body: {
          type: "object",
          properties: {
            source: { type: "string" },
            projectId: { type: "string" },
          },
        },
        response: { 200: envelope() },
      },
    },
    async (request) => {
      const { decision: decisionRecord, instance: negotiation } = await fastify.concord.negotiation.close({
        negotiationId: request.params.negotiationId as never,
        source: (request.body.source ?? "structured_negotiation") as never,
        projectId: request.body.projectId,
      });
      const { createEvent } = await import("@vibly-ai/concord-foundation");
      const evt = createEvent({ type: "NegotiationClosed", payload: { decisionRecord, negotiation } });
      await fastify.concord.state.events.append(evt);
      fastify.eventBus.publish(evt);
      return ok({ decisionRecord, negotiation });
    },
  );

  // POST /negotiations/:negotiationId/fork
  fastify.post<{
    Params: { negotiationId: string };
    Body: {
      newInitiatorId: string;
      participantIds: string[];
      forkReason: string;
      maxRounds?: number;
      convergenceThreshold?: number;
    };
  }>(
    "/negotiations/:negotiationId/fork",
    {
      schema: {
        tags: ["Negotiations"],
        summary: "Fork a negotiation: create a new NegotiationInstance branching from this one with a different initiator and participants",
        params: { type: "object", required: ["negotiationId"], properties: { negotiationId: { type: "string" } } },
        body: {
          type: "object",
          required: ["newInitiatorId", "participantIds", "forkReason"],
          properties: {
            newInitiatorId: { type: "string" },
            participantIds: { type: "array", items: { type: "string" } },
            forkReason: { type: "string" },
            maxRounds: { type: "number" },
            convergenceThreshold: { type: "number" },
          },
        },
        response: { 200: envelopeKey("negotiation") },
      },
    },
    async (request) => {
      const parent = await fastify.concord.negotiation.get(request.params.negotiationId as never);
      if (!parent) throw notFound("Negotiation", request.params.negotiationId);

      const initiatorActor = await fastify.concord.actors.get(request.body.newInitiatorId as never);
      if (!initiatorActor) throw notFound("Actor", request.body.newInitiatorId);

      const participants = (
        await Promise.all(request.body.participantIds.map((id) => fastify.concord.actors.get(id as never)))
      ).filter(Boolean) as never[];

      const fork = await fastify.concord.negotiation.fork({
        parentNegotiationId: parent.id,
        newInitiator: initiatorActor as never,
        participants,
        forkReason: request.body.forkReason,
        context: parent.context as never,
        ...(request.body.maxRounds !== undefined && { maxRounds: request.body.maxRounds }),
        ...(request.body.convergenceThreshold !== undefined && { convergenceThreshold: request.body.convergenceThreshold }),
      });

      const { createEvent } = await import("@vibly-ai/concord-foundation");
      const evt = createEvent({ type: "NegotiationForked", payload: { fork, parentNegotiationId: parent.id } });
      await fastify.concord.state.events.append(evt);
      fastify.eventBus.publish(evt);
      return ok({ negotiation: fork });
    },
  );
};

export default negotiationsRoutes;
