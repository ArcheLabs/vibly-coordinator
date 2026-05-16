import type { FastifyPluginAsync } from "fastify";
import EventEmitter from "node:events";
import type { EventEnvelope } from "@concord/foundation";
import { authPolicy } from "../../../plugins/authPolicy.js";
import type { EventMetadata } from "../../../services/eventBus.js";

const sseResponse200 = {
  description: "Server-Sent Events stream of EventEnvelope frames",
  content: {
    "text/event-stream": { schema: { type: "string" } },
  },
} as const;

function lastEventIdFromRequest(request: { headers: Record<string, string | string[] | undefined> }): number | undefined {
  const raw = request.headers["last-event-id"] ?? request.headers["Last-Event-ID"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const streamsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: { projectId?: string; type?: string; actorId?: string };
  }>(
    "/streams/events",
    {
      ...authPolicy("wallet-session", {
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
        response: { 200: sseResponse200 },
      }),
    },
    async (request, reply) => {
      const { projectId, type, actorId } = request.query;

      const bridge = new EventEmitter();

      const filter: (event: EventEnvelope<string, unknown>) => boolean = (event) => {
        if (projectId && (event as unknown as { projectId?: string }).projectId !== projectId) return false;
        if (type && event.type !== type) return false;
        if (actorId && (event as unknown as { actorId?: string }).actorId !== actorId) return false;
        return true;
      };

      const since = lastEventIdFromRequest(request);
      if (since !== undefined && fastify.eventBus.replaySince) {
        await fastify.eventBus.replaySince(since, (event, metadata) => {
          if (!filter(event)) return;
          bridge.emit("event", event, metadata);
        });
      }

      const unsubscribe = fastify.eventBus.subscribe(
        (event, metadata) => {
          bridge.emit("event", event, metadata);
        },
        filter,
      );

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.raw.flushHeaders();

      const sendEvent = (name: string, data: unknown, id?: number) => {
        if (id !== undefined) {
          reply.raw.write(`id: ${id}\n`);
        }
        reply.raw.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      bridge.on("event", (data, metadata?: EventMetadata) => sendEvent("EventEnvelope", data, metadata?.streamId));

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

  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/stream",
    {
      ...authPolicy("wallet-session", {
        tags: ["Streams"],
        summary: "Project-scoped SSE event stream",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        response: { 200: sseResponse200 },
      }),
    },
    async (request, reply) => {
      const { projectId } = request.params;

      const bridge = new EventEmitter();

      const since = lastEventIdFromRequest(request);
      if (since !== undefined && fastify.eventBus.replaySince) {
        await fastify.eventBus.replaySince(since, (event, metadata) => {
          const p = event as unknown as { projectId?: string; payload?: { projectId?: string } };
          if (p.projectId === projectId || p.payload?.projectId === projectId) {
            bridge.emit("event", event, metadata);
          }
        });
      }

      const unsubscribe = fastify.eventBus.subscribe(
        (event, metadata) => bridge.emit("event", event, metadata),
        (event) => {
          const p = event as unknown as { projectId?: string; payload?: { projectId?: string } };
          return p.projectId === projectId || p.payload?.projectId === projectId;
        },
      );

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.raw.flushHeaders();

      const sendEvent = (name: string, data: unknown, id?: number) => {
        if (id !== undefined) {
          reply.raw.write(`id: ${id}\n`);
        }
        reply.raw.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      bridge.on("event", (data, metadata?: EventMetadata) => sendEvent("ProjectEvent", data, metadata?.streamId));

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
