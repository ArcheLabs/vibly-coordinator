import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import type { GovernanceVoteStance } from "@concord/governance";
import { GovernanceProjectionRepository } from "../shared/repository.js";
import { subjectSchemas } from "./schemas.js";
import { queryGovernanceCheckpoint } from "./queries.js";
import { castSubjectVoteOpenGov } from "./commands.js";

const subjectsRoutes: FastifyPluginAsync = async (fastify) => {
  const repo = new GovernanceProjectionRepository(fastify.coordinatorStore);

  fastify.get("/governance/views", { schema: subjectSchemas.listLegacyViews }, async () => {
    const items = await repo.listLegacyGovernanceViews();
    return ok({ items });
  });

  fastify.get<{ Params: { subjectId: string } }>(
    "/governance/views/:subjectId",
    { schema: subjectSchemas.getLegacyView },
    async (request) => {
      const view = await repo.getLegacyGovernanceView(request.params.subjectId);
      if (!view) throw notFound("GovernanceView", request.params.subjectId);
      return ok({ view });
    },
  );

  fastify.get<{ Querystring: { backend?: string; chainId?: string } }>(
    "/governance/checkpoint",
    { schema: subjectSchemas.getCheckpoint },
    async (request) => {
      const data = await queryGovernanceCheckpoint(fastify, repo, request.query);
      return ok(data);
    },
  );

  fastify.get<{ Querystring: { chainId?: string; status?: string; backend?: string; limit?: number } }>(
    "/governance/subjects",
    { schema: subjectSchemas.listSubjects },
    async (request) => {
      const { chainId, status, backend, limit = 50 } = request.query;
      const items = await repo.listSubjects({ chainId, status, backend, limit });
      return ok({ items });
    },
  );

  fastify.get<{ Params: { subjectId: string } }>(
    "/governance/subjects/:subjectId",
    { schema: subjectSchemas.getSubject },
    async (request) => {
      const view = await repo.getSubject(request.params.subjectId);
      if (!view) throw notFound("GovernanceSubjectView", request.params.subjectId);
      return ok({ subject: view });
    },
  );

  fastify.get<{ Params: { subjectId: string } }>(
    "/governance/subjects/:subjectId/votes",
    { schema: subjectSchemas.listSubjectVotes },
    async (request) => {
      const items = await repo.listVotesForSubject(request.params.subjectId);
      return ok({ items });
    },
  );

  fastify.post<{
    Params: { subjectId: string };
    Body: {
      voter: string;
      stance: GovernanceVoteStance;
      weight?: string;
      reason?: string;
      conviction?: string | number;
      payload?: unknown;
      metadata?: Record<string, unknown>;
    };
  }>(
    "/governance/subjects/:subjectId/vote-opengov",
    { schema: subjectSchemas.postVoteOpenGov },
    async (request) => {
      const receipt = await castSubjectVoteOpenGov(
        fastify,
        repo,
        request.params.subjectId,
        request.body,
      );
      return ok({ receipt });
    },
  );

  fastify.get<{ Querystring: { chainId?: string; limit?: number } }>(
    "/governance/delegations",
    { schema: subjectSchemas.listDelegations },
    async (request) => {
      const { chainId, limit = 50 } = request.query;
      const items = await repo.listDelegations({ chainId, limit });
      return ok({ items });
    },
  );
};

export default subjectsRoutes;
