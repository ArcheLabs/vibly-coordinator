import type { FastifyPluginAsync } from "fastify";
import type { CoordinatorConfig } from "../../config/env.js";
import { ok } from "../../domain/apiTypes.js";

export interface HealthPluginOptions {
  config: CoordinatorConfig;
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
};

export default healthRoutes;
