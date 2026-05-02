import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../../domain/apiTypes.js";
import { forbidden } from "../../../domain/errors.js";
import { GovernanceProjectionRepository } from "../shared/repository.js";
import { backendSchemas } from "./schemas.js";
import { listGovernanceBackends } from "./queries.js";
import { seedPhaseD5GovernanceDemo } from "./commands.js";

const backendsRoutes: FastifyPluginAsync = async (fastify) => {
  const repo = new GovernanceProjectionRepository(fastify.coordinatorStore);

  fastify.get("/governance/backends", { schema: backendSchemas.listBackends }, async () => {
    const backends = await listGovernanceBackends(fastify, repo);
    return ok({ backends });
  });

  fastify.post("/governance/dev/seed-demo", { schema: backendSchemas.postSeedDemo }, async () => {
    if (!fastify.config.enableDevRoutes) {
      throw forbidden("Dev routes are disabled");
    }
    const seeded = await seedPhaseD5GovernanceDemo(fastify, repo);
    return ok(seeded);
  });
};

export default backendsRoutes;
