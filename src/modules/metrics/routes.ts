import type { FastifyPluginAsync } from "fastify";
import { metricsRegister } from "../../telemetry/metrics.js";

const metricsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/metrics",
    {
      schema: {
        tags: ["Health"],
        summary: "Prometheus metrics",
        response: {
          200: {
            description: "Prometheus text exposition format",
            type: "string",
          },
        },
      },
    },
    async (_request, reply) => {
      reply.header("content-type", metricsRegister.contentType);
      return reply.send(await metricsRegister.metrics());
    },
  );
};

export default metricsRoutes;
