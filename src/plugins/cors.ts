import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyPluginAsync } from "fastify";
import type { CoordinatorConfig } from "../config/env.js";

export interface CorsPluginOptions {
  config: CoordinatorConfig;
}

const corsPlugin: FastifyPluginAsync<CorsPluginOptions> = async (fastify, opts) => {
  await fastify.register(cors, {
    origin: opts.config.nodeEnv === "production" ? false : true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
};

export default fp(corsPlugin, { name: "cors" });
