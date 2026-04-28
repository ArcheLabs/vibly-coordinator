import type { FastifyPluginAsync } from "fastify";
import EventEmitter from "node:events";

// Re-use the same raw emitter bound to the eventBus for SSE
// We create a bridge from the EventBus abstraction to a raw EventEmitter for the SSE plugin

const streamsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /streams/events — global SSE event stream
  fastify.get<{
    Querystring: { projectId?: string; type?: string; actorId?: string };
  }>(
    "/streams/events",
    {
      schema: {
        tags: ["Streams"],
        summary: "Global SSE event stream",
        querystring: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            type: { type: "string" },
            actorId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { projectId, type, actorId } = request.query;

      // Create a per-request EventEmitter bridge
      const bridge = new EventEmitter();

      const unsubscribe = fastify.eventBus.subscribe(
        (event) => {
          bridge.emit("event", event);
        },
        (event) => {
          if (projectId && (event as unknown as { projectId?: string }).projectId !== projectId) return false;
          if (type && event.type !== type) return false;
          if (actorId && (event as unknown as { actorId?: string }).actorId !== actorId) return false;
          return true;
        },
      );

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.raw.flushHeaders();

      const sendEvent = (name: string, data: unknown) => {
        reply.raw.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      bridge.on("event", (data) => sendEvent("EventEnvelope", data));

      const heartbeat = setInterval(() => {
        sendEvent("heartbeat", { timestamp: new Date().toISOString() });
      }, fastify.config.sseHeartbeatMs);

      reply.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        bridge.removeAllListeners();
      });

      // Keep connection open
      await new Promise<void>((resolve) => {
        reply.raw.on("close", resolve);
      });
    },
  );

  // GET /projects/:projectId/stream — project-scoped SSE stream
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/stream",
    {
      schema: {
        tags: ["Streams"],
        summary: "Project-scoped SSE event stream",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;

      const bridge = new EventEmitter();

      const unsubscribe = fastify.eventBus.subscribe(
        (event) => bridge.emit("event", event),
        (event) => {
          const p = (event as unknown as { projectId?: string; payload?: { projectId?: string } });
          return p.projectId === projectId || p.payload?.projectId === projectId;
        },
      );

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.raw.flushHeaders();

      const sendEvent = (name: string, data: unknown) => {
        reply.raw.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      bridge.on("event", (data) => sendEvent("ProjectEvent", data));

      const heartbeat = setInterval(() => {
        sendEvent("heartbeat", { timestamp: new Date().toISOString() });
      }, fastify.config.sseHeartbeatMs);

      reply.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        bridge.removeAllListeners();
      });

      await new Promise<void>((resolve) => {
        reply.raw.on("close", resolve);
      });
    },
  );
};

export default streamsRoutes;
