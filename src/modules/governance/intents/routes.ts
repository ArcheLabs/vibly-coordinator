import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { GovernanceProjectionRepository } from "../shared/repository.js";
import { intentSchemas } from "./schemas.js";
import { getIntentById } from "./queries.js";
import {
  createIntent,
  linkIntentToSubject,
  reconcileIntentWithSubject,
  submitIntentMock,
  submitIntentOpenGov,
} from "./commands.js";

const intentsRoutes: FastifyPluginAsync = async (fastify) => {
  const repo = new GovernanceProjectionRepository(fastify.coordinatorStore);

  fastify.post<{
    Body: {
      projectId?: string;
      kind: string;
      actionId?: string;
      decisionRecordId?: string;
      title: string;
      body?: string;
    };
  }>("/governance/intents", { schema: intentSchemas.postCreate }, async (request) => {
    const intent = await createIntent(fastify, repo, request.body);
    return ok({ governanceIntent: intent });
  });

  fastify.get<{ Params: { governanceIntentId: string } }>(
    "/governance/intents/:governanceIntentId",
    { schema: intentSchemas.getIntent },
    async (request) => {
      const intent = await getIntentById(repo, request.params.governanceIntentId);
      if (!intent) throw notFound("GovernanceIntent", request.params.governanceIntentId);
      return ok({ governanceIntent: intent });
    },
  );

  fastify.post<{
    Params: { governanceIntentId: string };
    Body: {
      actor: string;
      payload?: unknown;
      submitArgs?: unknown;
      externalId?: string;
      subjectId?: string;
      metadata?: Record<string, unknown>;
    };
  }>(
    "/governance/intents/:governanceIntentId/submit-opengov",
    { schema: intentSchemas.postSubmitOpenGov },
    async (request) => {
      const result = await submitIntentOpenGov(
        fastify,
        repo,
        request.params.governanceIntentId,
        request.body,
      );
      return ok(result);
    },
  );

  fastify.post<{ Params: { governanceIntentId: string } }>(
    "/governance/intents/:governanceIntentId/submit-mock",
    { schema: intentSchemas.postSubmitMock },
    async (request, reply) => {
      const result = await submitIntentMock(fastify, repo, request.params.governanceIntentId);
      void reply.header("Deprecation", "true");
      void reply.header("Sunset", "2026-12-31");
      return ok(result);
    },
  );

  fastify.post<{
    Params: { governanceIntentId: string };
    Body: {
      subjectId: string;
      externalId?: string;
      backend?: string;
      linkSource?: string;
      confidence?: string;
      metadata?: Record<string, unknown>;
    };
  }>(
    "/governance/intents/:governanceIntentId/link-subject",
    { schema: intentSchemas.postLinkSubject },
    async (request) => {
      const link = await linkIntentToSubject(
        fastify,
        repo,
        request.params.governanceIntentId,
        request.body,
      );
      return ok({ link });
    },
  );

  fastify.post<{
    Params: { governanceIntentId: string };
    Body: { subjectId?: string; externalId?: string; metadata?: Record<string, unknown> };
  }>(
    "/governance/intents/:governanceIntentId/reconcile-subject",
    { schema: intentSchemas.postReconcileSubject },
    async (request) => {
      const { governanceIntent, link, receiptsTouched } = await reconcileIntentWithSubject(
        repo,
        request.params.governanceIntentId,
        request.body,
      );
      return ok({ governanceIntent, link, receipts: receiptsTouched });
    },
  );
};

export default intentsRoutes;
