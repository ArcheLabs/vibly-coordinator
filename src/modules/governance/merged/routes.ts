import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { GovernanceProjectionRepository } from "../shared/repository.js";
import { mergedSchemas } from "./schemas.js";
import { queryGovernanceMergedDetail, queryGovernanceMergedList } from "./queries.js";

const mergedRoutes: FastifyPluginAsync = async (fastify) => {
  const repo = new GovernanceProjectionRepository(fastify.coordinatorStore);

  fastify.get<{ Querystring: { projectId?: string; backend?: string; limit?: number } }>(
    "/governance/merged",
    { schema: mergedSchemas.listMerged },
    async (request) => {
      const { projectId, backend, limit = 50 } = request.query;
      const items = await queryGovernanceMergedList(repo, { projectId, backend, limit });
      return ok({ items });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/governance/merged/:id",
    { schema: mergedSchemas.getMergedDetail },
    async (request) => {
      const merged = await queryGovernanceMergedDetail(repo, request.params.id);
      if (!merged) throw notFound("GovernanceMergedView", request.params.id);
      return ok({ merged });
    },
  );
};

export default mergedRoutes;
