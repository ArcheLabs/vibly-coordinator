import type { FastifyInstance } from "fastify";
import { buildBackendReadModels } from "../shared/readModel.js";
import { GovernanceProjectionRepository } from "../shared/repository.js";
import type { GovernanceBackendReadModel } from "../shared/types.js";

export async function listGovernanceBackends(
  fastify: FastifyInstance,
  repo: GovernanceProjectionRepository,
): Promise<GovernanceBackendReadModel[]> {
  const checkpoints = await repo.listCheckpoints();
  return buildBackendReadModels(fastify.governanceBackendRegistry.listDescriptors(), checkpoints);
}
