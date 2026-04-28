import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { EventEmitter } from "node:events";

export interface SsePluginOptions {
  heartbeatMs: number;
}

declare module "fastify" {
  interface FastifyReply {
    sendSse(emitter: EventEmitter, eventName: string, filter?: (data: unknown) => boolean): void;
  }
}

const ssePlugin: FastifyPluginAsync<SsePluginOptions> = async (fastify, opts) => {
  fastify.decorateReply("sendSse", function (
    this: FastifyReply,
    emitter: EventEmitter,
    eventName: string,
    filter?: (data: unknown) => boolean,
  ) {
    const reply = this;
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();

    const sendEvent = (name: string, data: unknown) => {
      reply.raw.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onEvent = (data: unknown) => {
      if (!filter || filter(data)) {
        sendEvent(eventName, data);
      }
    };

    emitter.on(eventName, onEvent);

    const heartbeat = setInterval(() => {
      sendEvent("heartbeat", { timestamp: new Date().toISOString() });
    }, opts.heartbeatMs);

    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      emitter.off(eventName, onEvent);
    });
  });
};

export default fp(ssePlugin, { name: "sse" });
