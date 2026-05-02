import type { FastifyPluginAsync } from "fastify";
import intentsRoutes from "./intents/routes.js";
import subjectsRoutes from "./subjects/routes.js";
import mergedRoutes from "./merged/routes.js";
import backendsRoutes from "./backends/routes.js";

/** Aggregate plugin that registers every governance sub-capability under one Fastify scope. */
const governanceRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(intentsRoutes);
  await fastify.register(subjectsRoutes);
  await fastify.register(mergedRoutes);
  await fastify.register(backendsRoutes);
};

export default governanceRoutes;
