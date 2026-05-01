import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../../domain/apiTypes.js";
import { forbidden, notFound } from "../../../domain/errors.js";
import type { GovernanceIntentChainLink, GovernanceVoteStance } from "@concord/governance";
import { governanceRouteSchemas } from "./schemas/routeSchemas.js";
import { GovernanceProjectionRepository } from "./repositories/governanceProjectionRepository.js";
import { createSubstrateGovernanceActionsAdapter } from "./service/substrateGovernanceAdapter.js";
import {
  maybeLinkSubmittedIntent,
  saveGovernanceTxReceipt,
  seedPhaseD5GovernanceDemo,
} from "./commands/governanceWriteCommands.js";
import {
  queryGovernanceCheckpoint,
  queryGovernanceMergedDetail,
  queryGovernanceMergedList,
} from "./queries/governanceQueries.js";
import { buildBackendReadModels, findGovernanceSubjectForReconciliation, summarizePayload } from "./readModel.js";
import type { GovernanceTxReceiptProjection } from "./types.js";

const governanceRoutes: FastifyPluginAsync = async (fastify) => {
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
  }>("/governance/intents", { schema: governanceRouteSchemas.postCreateIntent }, async (request) => {
    const { createEvent, makeId } = await import("@concord/foundation");
    const now = new Date().toISOString();
    const intent = {
      id: makeId("GovernanceIntentId"),
      projectId: request.body.projectId,
      kind: request.body.kind,
      actionId: request.body.actionId,
      decisionRecordId: request.body.decisionRecordId,
      title: request.body.title,
      body: request.body.body,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    await repo.saveRawProjection("governance_intent", String(intent.id), intent);
    const evt = createEvent({ type: "GovernanceIntentCreated", payload: intent });
    await fastify.concord.state.events.append(evt);
    fastify.eventBus.publish(evt);
    return ok({ governanceIntent: intent });
  });

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
    { schema: governanceRouteSchemas.postSubmitOpenGov },
    async (request) => {
      const intent = await repo.getProjection<{
        id: string;
        projectId?: string;
        kind: string;
        title: string;
        body?: string;
        status: string;
      }>("governance_intent", request.params.governanceIntentId);
      if (!intent) throw notFound("GovernanceIntent", request.params.governanceIntentId);

      const chain = { namespace: "substrate" as const, chainId: fastify.config.substrateChainId ?? "substrate:vibly-solo" };
      const adapter = await createSubstrateGovernanceActionsAdapter(fastify);
      const metadata: Record<string, unknown> = {
        ...(request.body.metadata ?? {}),
        governanceIntentId: intent.id,
      };
      if (request.body.submitArgs !== undefined) metadata["submitArgs"] = request.body.submitArgs;
      const prepareInput = {
        chain,
        actor: request.body.actor,
        title: intent.title,
        metadata,
      };
      if (intent.body !== undefined) {
        (prepareInput as typeof prepareInput & { description: string }).description = intent.body;
      }
      const prepared = await adapter.prepareProposal(prepareInput);
      const tx = await adapter.submitProposal({
        chain,
        actor: request.body.actor,
        payload: request.body.payload ?? prepared.payload,
      });
      const receipt = await saveGovernanceTxReceipt(fastify, {
        intentId: intent.id,
        action: "submitProposal",
        chain,
        actor: request.body.actor,
        tx,
        payloadSummary: summarizePayload(prepared.payload),
        readbackStatus: request.body.subjectId || request.body.externalId ? "linked" : "pending_indexer",
      });

      const updated = {
        ...intent,
        status: "submitted",
        submitReceiptId: receipt.id,
        readbackStatus: receipt.readbackStatus,
        updatedAt: receipt.updatedAt,
      };
      await repo.saveIntent(intent.id, updated);

      const link = await maybeLinkSubmittedIntent(fastify, {
        intentId: intent.id,
        chain,
        externalId: request.body.externalId,
        subjectId: request.body.subjectId,
        tx,
      });
      const { createEvent } = await import("@concord/foundation");
      const evt = createEvent({ type: "GovernanceSubmittedOpenGov", payload: { governanceIntentId: intent.id, receipt, link } });
      await fastify.concord.state.events.append(evt);
      fastify.eventBus.publish(evt);

      return ok({ governanceIntent: updated, receipt, link });
    },
  );

  fastify.get<{ Params: { governanceIntentId: string } }>(
    "/governance/intents/:governanceIntentId",
    { schema: governanceRouteSchemas.getIntent },
    async (request) => {
      const intent = await repo.getProjection("governance_intent", request.params.governanceIntentId);
      if (!intent) throw notFound("GovernanceIntent", request.params.governanceIntentId);
      return ok({ governanceIntent: intent });
    },
  );

  fastify.post<{ Params: { governanceIntentId: string } }>(
    "/governance/intents/:governanceIntentId/submit-mock",
    { schema: governanceRouteSchemas.postSubmitMock },
    async (request, reply) => {
      const intent = await repo.getProjection<{
        id: string;
        kind: string;
        title: string;
        body?: string;
        status: string;
      }>("governance_intent", request.params.governanceIntentId);
      if (!intent) throw notFound("GovernanceIntent", request.params.governanceIntentId);

      const result = await fastify.concord.governanceGateway.submitProposal({
        kind: intent.kind,
        title: intent.title,
        body: intent.body ?? "",
        referenceId: intent.id,
      });

      const updated = { ...intent, status: "submitted", mockResult: result, updatedAt: new Date().toISOString() };
      await repo.saveIntent(intent.id, updated);

      const { createEvent } = await import("@concord/foundation");
      const evt = createEvent({ type: "GovernanceSubmittedMock", payload: { governanceIntentId: intent.id, result } });
      await fastify.concord.state.events.append(evt);
      fastify.eventBus.publish(evt);

      void reply.header("Deprecation", "true");
      void reply.header("Sunset", "2026-12-31");

      return ok({ governanceIntent: updated, result });
    },
  );

  fastify.get("/governance/views", { schema: governanceRouteSchemas.listLegacyViews }, async () => {
    const items = await repo.listLegacyGovernanceViews();
    return ok({ items });
  });

  fastify.get<{ Params: { subjectId: string } }>(
    "/governance/views/:subjectId",
    { schema: governanceRouteSchemas.getLegacyView },
    async (request) => {
      const view = await repo.getLegacyGovernanceView(request.params.subjectId);
      if (!view) throw notFound("GovernanceView", request.params.subjectId);
      return ok({ view });
    },
  );

  fastify.get<{ Querystring: { backend?: string; chainId?: string } }>(
    "/governance/checkpoint",
    { schema: governanceRouteSchemas.getCheckpoint },
    async (request) => {
      const data = await queryGovernanceCheckpoint(fastify, repo, request.query);
      return ok(data);
    },
  );

  fastify.get<{ Querystring: { chainId?: string; status?: string; backend?: string; limit?: number } }>(
    "/governance/subjects",
    { schema: governanceRouteSchemas.listSubjects },
    async (request) => {
      const { chainId, status, backend, limit = 50 } = request.query;
      const items = await repo.listSubjects({ chainId, status, backend, limit });
      return ok({ items });
    },
  );

  fastify.get<{ Params: { subjectId: string } }>(
    "/governance/subjects/:subjectId",
    { schema: governanceRouteSchemas.getSubject },
    async (request) => {
      const view = await repo.getSubject(request.params.subjectId);
      if (!view) throw notFound("GovernanceSubjectView", request.params.subjectId);
      return ok({ subject: view });
    },
  );

  fastify.get<{ Params: { subjectId: string } }>(
    "/governance/subjects/:subjectId/votes",
    { schema: governanceRouteSchemas.listSubjectVotes },
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
  }>("/governance/subjects/:subjectId/vote-opengov", { schema: governanceRouteSchemas.postVoteOpenGov }, async (request) => {
    const subject = await repo.getSubject(request.params.subjectId);
    if (!subject) throw notFound("GovernanceSubjectView", request.params.subjectId);
    if (subject.backend !== "substrate-opengov") {
      throw forbidden("Only substrate-opengov subjects can use vote-opengov");
    }

    const adapter = await createSubstrateGovernanceActionsAdapter(fastify);
    const metadata = { ...(request.body.metadata ?? {}) };
    if (request.body.conviction !== undefined) metadata["conviction"] = request.body.conviction;
    const prepared = await adapter.prepareVote({
      subject: { chain: subject.chain, backend: subject.backend, externalId: subject.externalId },
      voter: request.body.voter,
      stance: request.body.stance,
      weight: request.body.weight,
      reason: request.body.reason,
      metadata,
    });
    const tx = await adapter.castVote({
      subject: prepared.subject,
      voter: request.body.voter,
      payload: request.body.payload ?? prepared.payload,
    });
    const receipt = await saveGovernanceTxReceipt(fastify, {
      subjectId: subject.id,
      action: "castVote",
      chain: subject.chain,
      actor: request.body.voter,
      tx,
      payloadSummary: summarizePayload(prepared.payload),
      readbackStatus: "pending_indexer",
    });
    const { createEvent } = await import("@concord/foundation");
    const evt = createEvent({ type: "GovernanceVoteSubmittedOpenGov", payload: { subjectId: subject.id, receipt } });
    await fastify.concord.state.events.append(evt);
    fastify.eventBus.publish(evt);
    return ok({ receipt });
  });

  fastify.get<{ Querystring: { chainId?: string; limit?: number } }>(
    "/governance/delegations",
    { schema: governanceRouteSchemas.listDelegations },
    async (request) => {
      const { chainId, limit = 50 } = request.query;
      const items = await repo.listDelegations({ chainId, limit });
      return ok({ items });
    },
  );

  fastify.get<{ Querystring: { projectId?: string; backend?: string; limit?: number } }>(
    "/governance/merged",
    { schema: governanceRouteSchemas.listMerged },
    async (request) => {
      const { projectId, backend, limit = 50 } = request.query;
      const result = await queryGovernanceMergedList(repo, { projectId, backend, limit });
      return ok({ items: result });
    },
  );

  fastify.get("/governance/backends", { schema: governanceRouteSchemas.listBackends }, async () => {
    const checkpoints = await repo.listCheckpoints();
    const backends = buildBackendReadModels(fastify.governanceBackendRegistry.listDescriptors(), checkpoints);
    return ok({ backends });
  });

  fastify.post("/governance/dev/seed-demo", { schema: governanceRouteSchemas.postSeedDemo }, async () => {
    if (!fastify.config.enableDevRoutes) {
      throw forbidden("Dev routes are disabled");
    }
    const seeded = await seedPhaseD5GovernanceDemo(fastify);
    return ok(seeded);
  });

  fastify.get<{ Params: { id: string } }>(
    "/governance/merged/:id",
    { schema: governanceRouteSchemas.getMergedDetail },
    async (request) => {
      const merged = await queryGovernanceMergedDetail(repo, request.params.id);
      if (!merged) throw notFound("GovernanceMergedView", request.params.id);
      return ok({ merged });
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
  }>("/governance/intents/:governanceIntentId/link-subject", { schema: governanceRouteSchemas.postLinkSubject }, async (request) => {
    const { governanceIntentId } = request.params;
    const intent = await repo.getProjection("governance_intent", governanceIntentId);
    if (!intent) throw notFound("GovernanceIntent", governanceIntentId);

    const now = new Date().toISOString();
    const linkId = `link:${governanceIntentId}:${request.body.subjectId}`;
    const subject = await repo.getSubject(request.body.subjectId);

    const chainId = fastify.config.substrateChainId ?? "substrate:vibly-solo";
    const link: GovernanceIntentChainLink = {
      id: linkId,
      governanceIntentId,
      subjectId: request.body.subjectId,
      chain: subject?.chain ?? { namespace: "substrate", chainId },
      backend: (request.body.backend as GovernanceIntentChainLink["backend"]) ?? subject?.backend ?? "substrate-opengov",
      externalId: request.body.externalId ?? subject?.externalId ?? request.body.subjectId,
      linkSource: (request.body.linkSource as GovernanceIntentChainLink["linkSource"]) ?? "explicit",
      confidence: (request.body.confidence as GovernanceIntentChainLink["confidence"]) ?? "high",
      createdAt: now,
      updatedAt: now,
      metadata: request.body.metadata,
    };
    await repo.saveIntentChainLink(linkId, link);
    return ok({ link });
  });

  fastify.post<{
    Params: { governanceIntentId: string };
    Body: { subjectId?: string; externalId?: string; metadata?: Record<string, unknown> };
  }>(
    "/governance/intents/:governanceIntentId/reconcile-subject",
    { schema: governanceRouteSchemas.postReconcileSubject },
    async (request) => {
      const intent = await repo.getProjection<{
        id: string;
        status: string;
        submitReceiptId?: string;
        readbackStatus?: string;
      }>("governance_intent", request.params.governanceIntentId);
      if (!intent) throw notFound("GovernanceIntent", request.params.governanceIntentId);

      const allSubjects = await repo.listAllSubjects();
      const subject = findGovernanceSubjectForReconciliation(allSubjects, request.body);
      if (!subject) {
        throw notFound("GovernanceSubjectView", request.body.subjectId ?? request.body.externalId ?? "missing");
      }

      const now = new Date().toISOString();
      const link: GovernanceIntentChainLink = {
        id: `link:${intent.id}:${subject.id}`,
        governanceIntentId: intent.id,
        subjectId: subject.id,
        chain: subject.chain,
        backend: subject.backend,
        externalId: subject.externalId,
        linkSource: "metadata_match",
        confidence: "high",
        createdAt: now,
        updatedAt: now,
        metadata: {
          ...(request.body.metadata ?? {}),
          reconciledAt: now,
          readbackStatus: "linked",
        },
      };
      await repo.saveIntentChainLink(link.id, link);

      const allReconcileReceipts = await repo.listAllTxReceipts();
      const receipts = allReconcileReceipts.filter((receipt) => receipt.intentId === intent.id);
      for (const receipt of receipts) {
        await repo.saveTxReceipt(receipt.id, {
          ...receipt,
          subjectId: subject.id,
          readbackStatus: "linked",
          updatedAt: now,
        } satisfies GovernanceTxReceiptProjection);
      }

      const updated = {
        ...intent,
        status: subject.status,
        readbackStatus: "linked",
        updatedAt: now,
      };
      await repo.saveIntent(intent.id, updated);

      return ok({ governanceIntent: updated, link, receipts: receipts.length });
    },
  );
};

export default governanceRoutes;
