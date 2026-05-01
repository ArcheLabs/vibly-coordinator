import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { CoordinatorConfig } from "../../../config/env.js";
import { ok } from "../../../domain/apiTypes.js";

export interface HealthPluginOptions {
  config: CoordinatorConfig;
  readinessProbe?: () => Promise<void>;
}

const healthRoutes: FastifyPluginAsync<HealthPluginOptions> = async (fastify, opts) => {
  fastify.get(
    "/health",
    {
      schema: {
        tags: ["Health"],
        summary: "Health check",
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  status: { type: "string" },
                  coordinatorId: { type: "string" },
                  storageMode: { type: "string" },
                  version: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (_request, _reply) => {
      return ok({
        status: "ok",
        coordinatorId: opts.config.coordinatorId,
        storageMode: opts.config.storageMode,
        version: "0.1.0",
      });
    },
  );

  fastify.get(
    "/ready",
    {
      schema: {
        tags: ["Health"],
        summary: "Readiness probe (checks optional dependencies)",
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: { type: "object", properties: { status: { type: "string" } } },
            },
          },
          503: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
            },
          },
        },
      },
    },
    async (_request, reply: FastifyReply) => {
      if (!opts.readinessProbe) {
        return ok({ status: "ready" });
      }
      try {
        await opts.readinessProbe();
        return ok({ status: "ready" });
      } catch {
        return reply.code(503).send({
          ok: false,
          error: { code: "NOT_READY", message: "Readiness check failed" },
        });
      }
    },
  );
};

export default healthRoutes;
