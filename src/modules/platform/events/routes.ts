import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import type { EventEnvelope } from "@vibly-ai/concord-foundation";
import { envelope, errorEnvelope, listEnvelope } from "../../../domain/schemas.js";
import { authPolicy } from "../../../plugins/authPolicy.js";

const eventsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /events — query event log
  fastify.get<{
    Querystring: { type?: string; actorId?: string; correlationId?: string; limit?: string; cursor?: string };
  }>(
    "/events",
    {
      ...authPolicy("public-read", {
        tags: ["Events"],
        summary: "Query event log",
        querystring: {
          type: "object",
          properties: {
            type: { type: "string" },
            actorId: { type: "string" },
            correlationId: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: { 200: listEnvelope() },
      }),
    },
    async (request) => {
      const { type, actorId, correlationId, limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);

      const allEvents = await fastify.concord.state.events.query();
      let filtered: EventEnvelope<string, unknown>[] = allEvents;

      if (type) filtered = filtered.filter((e) => e.type === type);
      if (actorId) filtered = filtered.filter((e) => (e as unknown as { actorId?: string }).actorId === actorId);
      if (correlationId) filtered = filtered.filter((e) => (e as unknown as { correlationId?: string }).correlationId === correlationId);

      // Cursor-based pagination
      let startIdx = 0;
      if (cursor) {
        const idx = filtered.findIndex((e) => e.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }

      const page = filtered.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;

      return okList(page, { limit, nextCursor });
    },
  );

  // GET /events/:eventId — get single event
  fastify.get<{ Params: { eventId: string } }>(
    "/events/:eventId",
    {
      ...authPolicy("public-read", {
        tags: ["Events"],
        summary: "Get a single event by ID",
        params: {
          type: "object",
          required: ["eventId"],
          properties: { eventId: { type: "string" } },
        },
        response: { 200: envelope() },
      }),
    },
    async (request) => {
      const { eventId } = request.params;
      const allEvents = await fastify.concord.state.events.query();
      const event = allEvents.find((e) => e.id === eventId);
      if (!event) throw notFound("Event", eventId);
      return ok(event);
    },
  );

  // POST /events — dev route to inject events
  fastify.post<{ Body: { event: EventEnvelope<string, unknown> } }>(
    "/events",
    {
      ...authPolicy("service-token", {
        tags: ["Events"],
        summary: "Inject event (dev only)",
        body: {
          type: "object",
          required: ["event"],
          properties: { event: { type: "object" } },
        },
        response: { 200: envelope(), 403: errorEnvelope },
      }),
    },
    async (request, reply) => {
      if (!fastify.config.enableDevRoutes) {
        return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: "Dev routes disabled" }, meta: { requestId: "req_" + Date.now() } });
      }
      await fastify.concord.state.events.append(request.body.event);
      fastify.eventBus.publish(request.body.event);
      return ok(request.body.event);
    },
  );
};

export default eventsRoutes;
