import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyPluginAsync } from "fastify";
import type { CoordinatorConfig } from "../config/env.js";

export interface SwaggerPluginOptions {
  config: CoordinatorConfig;
}

const swaggerPlugin: FastifyPluginAsync<SwaggerPluginOptions> = async (fastify, opts) => {
  if (!opts.config.enableSwagger) return;

  await fastify.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Vibly Coordinator API",
        description: "Early centralized coordination service for Vibly / Concord agent collaboration networks.",
        version: "0.1.0",
      },
      servers: [
        {
          url: `http://${opts.config.host}:${opts.config.port}`,
          description: "Local development server",
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description:
              "Protected coordinator routes use an opaque static Bearer token. User wallet flows use the x-wallet-session header instead of Authorization.",
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });
};

export default fp(swaggerPlugin, { name: "swagger" });
