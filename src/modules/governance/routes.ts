import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { forbidden, notFound } from "../../domain/errors.js";
import { envelope, envelopeKey, envelopeKeyArray, errorEnvelope } from "../../domain/schemas.js";
import {
  GOVERNANCE_SUBJECT_VIEW,
  GOVERNANCE_VOTE_ACTIVITY,
  GOVERNANCE_DELEGATION,
  GOVERNANCE_CHECKPOINT,
  GOVERNANCE_INTENT_CHAIN_LINK,
  GOVERNANCE_TX_RECEIPT,
} from "../../db/projectionKinds.js";
import { buildMergedView, isCheckpointStale } from "./mergeBuilder.js";
import type {
  GovernanceBackendDescriptor,
  GovernanceSubjectView,
  GovernanceVoteActivityView,
  GovernanceDelegationView,
  GovernanceCheckpointView,
  GovernanceIntentChainLink,
  GovernanceVoteStance,
} from "@concord/governance";
import type { ChainRef, TxReceipt } from "@concord/core";

type BackendHealthStatus = "healthy" | "stale" | "unavailable";

interface GovernanceBackendHealth {
  status: BackendHealthStatus;
  stale: boolean;
  reason?: string;
  lastObservedAt?: string;
  checkpoint?: GovernanceCheckpointView;
}

type GovernanceBackendReadModel = GovernanceBackendDescriptor & {
  health: GovernanceBackendHealth;
};

interface GovernanceTxReceiptProjection {
  id: string;
  intentId?: string;
  subjectId?: string;
  action: "submitProposal" | "castVote";
  backend: "substrate-opengov";
  chain: ChainRef;
  actor: string;
  tx: TxReceipt;
  payloadSummary?: Record<string, unknown>;
  readbackStatus: "pending_indexer" | "linked" | "failed";
  createdAt: string;
  updatedAt: string;
}

const governanceRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /governance/intents
  fastify.post<{
    Body: {
      projectId?: string;
      kind: string;
      actionId?: string;
      decisionRecordId?: string;
      title: string;
      body?: string;
    };
  }>(
    "/governance/intents",
    {
      schema: {
        tags: ["Governance"],
        summary: "Create a governance intent",
        body: {
          type: "object",
          required: ["kind", "title"],
          properties: {
            projectId: { type: "string" },
            kind: { type: "string" },
            actionId: { type: "string" },
            decisionRecordId: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
          },
        },
        response: { 200: envelopeKey("governanceIntent") },
      },
    },
    async (request) => {
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
      await fastify.coordinatorStore.saveProjection("governance_intent", String(intent.id), intent);
      const evt = createEvent({ type: "GovernanceIntentCreated", payload: intent });
      await fastify.concord.state.events.append(evt);
      fastify.eventBus.publish(evt);
      return ok({ governanceIntent: intent });
    },
  );

  // POST /governance/intents/:governanceIntentId/submit-opengov
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
    {
      schema: {
        tags: ["Governance"],
        summary: "Submit a governance intent through the Substrate OpenGov action path",
        params: {
          type: "object",
          required: ["governanceIntentId"],
          properties: { governanceIntentId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["actor"],
          properties: {
            actor: { type: "string" },
            payload: {},
            submitArgs: {},
            externalId: { type: "string" },
            subjectId: { type: "string" },
            metadata: { type: "object" },
          },
        },
        response: { 200: envelope() },
      },
    },
    async (request) => {
      const intent = await fastify.coordinatorStore.getProjection<{
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
      await fastify.coordinatorStore.saveProjection("governance_intent", intent.id, updated);

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

  // GET /governance/intents/:governanceIntentId
  fastify.get<{ Params: { governanceIntentId: string } }>(
    "/governance/intents/:governanceIntentId",
    {
      schema: {
        tags: ["Governance"],
        summary: "Get a governance intent",
        params: {
          type: "object",
          required: ["governanceIntentId"],
          properties: { governanceIntentId: { type: "string" } },
        },
        response: { 200: envelopeKey("governanceIntent") },
      },
    },
    async (request) => {
      const intent = await fastify.coordinatorStore.getProjection("governance_intent", request.params.governanceIntentId);
      if (!intent) throw notFound("GovernanceIntent", request.params.governanceIntentId);
      return ok({ governanceIntent: intent });
    },
  );

  // POST /governance/intents/:governanceIntentId/submit-mock
  fastify.post<{ Params: { governanceIntentId: string } }>(
    "/governance/intents/:governanceIntentId/submit-mock",
    {
      schema: {
        tags: ["Governance"],
        summary: "Mock submit governance intent (MockGovernanceGateway)",
        params: {
          type: "object",
          required: ["governanceIntentId"],
          properties: { governanceIntentId: { type: "string" } },
        },
        response: { 200: envelope() },
      },
    },
    async (request, reply) => {
      const intent = await fastify.coordinatorStore.getProjection<{
        id: string;
        kind: string;
        title: string;
        body?: string;
        status: string;
      }>("governance_intent", request.params.governanceIntentId);
      if (!intent) throw notFound("GovernanceIntent", request.params.governanceIntentId);

      // Call GovernanceGateway.submitProposal (which is MockGovernanceGateway in dev)
      const result = await fastify.concord.governanceGateway.submitProposal({
        kind: intent.kind,
        title: intent.title,
        body: intent.body ?? "",
        referenceId: intent.id,
      });

      const updated = { ...intent, status: "submitted", mockResult: result, updatedAt: new Date().toISOString() };
      await fastify.coordinatorStore.saveProjection("governance_intent", intent.id, updated);

      const { createEvent } = await import("@concord/foundation");
      const evt = createEvent({ type: "GovernanceSubmittedMock", payload: { governanceIntentId: intent.id, result } });
      await fastify.concord.state.events.append(evt);
      fastify.eventBus.publish(evt);

      // Deprecated: use /governance/views for chain-indexed data
      void reply.header("Deprecation", "true");
      void reply.header("Sunset", "2026-12-31");

      return ok({ governanceIntent: updated, result });
    },
  );

  // ── GET /governance/views ─────────────────────────────────────────────────
  // List all governance views written by GovernanceIndexConsumer.
  fastify.get(
    "/governance/views",
    {
      schema: {
        tags: ["Governance"],
        summary: "List governance subject views (from chain indexer)",
        response: { 200: envelopeKeyArray("items") },
      },
    },
    async () => {
      const items = await fastify.coordinatorStore.listProjections("governance_view") as unknown[];
      return ok({ items });
    },
  );

  // ── GET /governance/views/:subjectId ──────────────────────────────────────
  fastify.get<{ Params: { subjectId: string } }>(
    "/governance/views/:subjectId",
    {
      schema: {
        tags: ["Governance"],
        summary: "Get a governance subject view by subjectId (chainId:referendumIndex)",
        params: {
          type: "object",
          required: ["subjectId"],
          properties: { subjectId: { type: "string" } },
        },
        response: { 200: envelopeKey("view") },
      },
    },
    async (request) => {
      const view = await fastify.coordinatorStore.getProjection("governance_view", request.params.subjectId);
      if (!view) throw notFound("GovernanceView", request.params.subjectId);
      return ok({ view });
    },
  );

  // ── GET /governance/checkpoint ────────────────────────────────────────────
  // Returns the latest indexed block checkpoint from GovernanceIndexQueryPort.
  fastify.get<{ Querystring: { backend?: string; chainId?: string } }>(
    "/governance/checkpoint",
    {
      schema: {
        tags: ["Governance"],
        summary: "Get the latest governance index checkpoint",
        response: { 200: envelope() },
      },
    },
    async (request) => {
      const { backend, chainId } = request.query;
      const storedCheckpoints = await fastify.coordinatorStore.listProjections<GovernanceCheckpointView>(GOVERNANCE_CHECKPOINT);
      if (storedCheckpoints.length > 0 || backend || chainId) {
        const descriptors = fastify.governanceBackendRegistry.listDescriptors();
        const backendChains = backend
          ? descriptors.filter((descriptor) => descriptor.backend === backend).map((descriptor) => descriptor.chain)
          : [];
        const items = storedCheckpoints
          .filter((checkpoint) => !chainId || checkpoint.chain.chainId === chainId)
          .filter((checkpoint) => {
            if (!backend) return true;
            return backendChains.some((chain) => chainsEqual(chain, checkpoint.chain));
          })
          .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime());
        return ok({ checkpoint: items[0] ?? null, items });
      }

      const indexQuery = fastify.concord.governanceIndexQuery;
      if (!indexQuery) {
        return ok({ checkpoint: null, note: "governanceIndexQuery not configured" });
      }
      const substrateChainId = fastify.config.substrateChainId ?? "substrate:vibly-solo";
      const chain = { namespace: "substrate" as const, chainId: substrateChainId };
      const checkpoint = await indexQuery.getGovernanceCheckpoint({ chain });
      return ok({ checkpoint });
    },
  );

  // ── GET /governance/subjects ───────────────────────────────────────────────
  fastify.get<{ Querystring: { chainId?: string; status?: string; backend?: string; limit?: number } }>(
    "/governance/subjects",
    {
      schema: {
        tags: ["Governance"],
        summary: "List governance subject views (typed projection)",
        querystring: {
          type: "object",
          properties: {
            chainId: { type: "string" },
            status: { type: "string" },
            backend: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items") },
      },
    },
    async (request) => {
      const { chainId, status, backend, limit = 50 } = request.query;
      let items = await fastify.coordinatorStore.listProjections<GovernanceSubjectView>(GOVERNANCE_SUBJECT_VIEW);
      if (chainId) items = items.filter((s) => s.chain?.chainId === chainId);
      if (status) items = items.filter((s) => s.status === status);
      if (backend) items = items.filter((s) => s.backend === backend);
      return ok({ items: items.slice(0, limit) });
    },
  );

  // ── GET /governance/subjects/:subjectId ───────────────────────────────────
  fastify.get<{ Params: { subjectId: string } }>(
    "/governance/subjects/:subjectId",
    {
      schema: {
        tags: ["Governance"],
        summary: "Get a governance subject view by id",
        params: {
          type: "object",
          required: ["subjectId"],
          properties: { subjectId: { type: "string" } },
        },
        response: { 200: envelopeKey("subject") },
      },
    },
    async (request) => {
      const view = await fastify.coordinatorStore.getProjection<GovernanceSubjectView>(
        GOVERNANCE_SUBJECT_VIEW,
        request.params.subjectId,
      );
      if (!view) throw notFound("GovernanceSubjectView", request.params.subjectId);
      return ok({ subject: view });
    },
  );

  // ── GET /governance/subjects/:subjectId/votes ─────────────────────────────
  fastify.get<{ Params: { subjectId: string } }>(
    "/governance/subjects/:subjectId/votes",
    {
      schema: {
        tags: ["Governance"],
        summary: "List vote activity for a governance subject",
        params: {
          type: "object",
          required: ["subjectId"],
          properties: { subjectId: { type: "string" } },
        },
        response: { 200: envelopeKeyArray("items") },
      },
    },
    async (request) => {
      const all = await fastify.coordinatorStore.listProjections<GovernanceVoteActivityView>(GOVERNANCE_VOTE_ACTIVITY);
      const items = all.filter((v) => v.subjectId === request.params.subjectId);
      return ok({ items });
    },
  );

  // ── POST /governance/subjects/:subjectId/vote-opengov ─────────────────────
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
    {
      schema: {
        tags: ["Governance"],
        summary: "Cast a Substrate OpenGov vote for an indexed governance subject",
        params: {
          type: "object",
          required: ["subjectId"],
          properties: { subjectId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["voter", "stance"],
          properties: {
            voter: { type: "string" },
            stance: { type: "string" },
            weight: { type: "string" },
            reason: { type: "string" },
            conviction: {},
            payload: {},
            metadata: { type: "object" },
          },
        },
        response: { 200: envelopeKey("receipt") },
      },
    },
    async (request) => {
      const subject = await fastify.coordinatorStore.getProjection<GovernanceSubjectView>(
        GOVERNANCE_SUBJECT_VIEW,
        request.params.subjectId,
      );
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
    },
  );

  // ── GET /governance/delegations ───────────────────────────────────────────
  fastify.get<{ Querystring: { chainId?: string; limit?: number } }>(
    "/governance/delegations",
    {
      schema: {
        tags: ["Governance"],
        summary: "List governance delegation views",
        querystring: {
          type: "object",
          properties: {
            chainId: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items") },
      },
    },
    async (request) => {
      const { chainId, limit = 50 } = request.query;
      let items = await fastify.coordinatorStore.listProjections<GovernanceDelegationView>(GOVERNANCE_DELEGATION);
      if (chainId) items = items.filter((d) => d.chain?.chainId === chainId);
      return ok({ items: items.slice(0, limit) });
    },
  );

  // ── GET /governance/merged ─────────────────────────────────────────────────
  fastify.get<{ Querystring: { projectId?: string; backend?: string; limit?: number } }>(
    "/governance/merged",
    {
      schema: {
        tags: ["Governance"],
        summary: "List merged governance views (intent + subject + link)",
        querystring: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            backend: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items") },
      },
    },
    async (request) => {
      const { projectId, backend, limit = 50 } = request.query;
      const intentRows = await fastify.coordinatorStore.listProjections<{
        id: string;
        projectId?: string;
        title?: string;
        status?: string;
        proposedBy?: string;
        createdAt?: string;
      }>("governance_intent");
      const intents = intentRows.filter((i) => !projectId || i.projectId === projectId);

      const subjects = await fastify.coordinatorStore.listProjections<GovernanceSubjectView>(GOVERNANCE_SUBJECT_VIEW);
      const links = await fastify.coordinatorStore.listProjections<GovernanceIntentChainLink>(GOVERNANCE_INTENT_CHAIN_LINK);
      const checkpoints = await fastify.coordinatorStore.listProjections<GovernanceCheckpointView>(GOVERNANCE_CHECKPOINT);
      const receipts = await fastify.coordinatorStore.listProjections<GovernanceTxReceiptProjection>(GOVERNANCE_TX_RECEIPT);

      const merged = intents.slice(0, limit).map((intent) => {
        const link = links.find((l) => l.governanceIntentId === intent.id);
        const subject = link ? subjects.find((s) => s.id === link.subjectId) : undefined;
        const checkpoint = selectCheckpointForGovernanceView(checkpoints, subject, link);
        return enrichMergedViewObservability({
          base: buildMergedView({
            id: `merged:${intent.id}`,
            projectId: intent.projectId,
            intent: { id: intent.id, title: intent.title, status: intent.status, proposedBy: intent.proposedBy, createdAt: intent.createdAt },
            subject,
            link,
            checkpoint,
          }),
          receipts,
          intentId: intent.id,
          subjectId: subject?.id,
        });
      });

      // Also include subjects without intents (orphan chain subjects)
      const linkedSubjectIds = new Set(links.map((l) => l.subjectId));
      for (const subject of subjects) {
        if (!linkedSubjectIds.has(subject.id) && merged.length < limit) {
          const checkpoint = selectCheckpointForGovernanceView(checkpoints, subject);
          merged.push(enrichMergedViewObservability({
            base: buildMergedView({
              id: `merged:${subject.id}`,
              subject,
              checkpoint,
            }),
            receipts,
            subjectId: subject.id,
          }));
        }
      }

      const result = backend ? merged.filter((m) => m.subject?.backend === backend) : merged;
      return ok({ items: result });
    },
  );

  // ── GET /governance/backends ──────────────────────────────────────────────
  fastify.get(
    "/governance/backends",
    {
      schema: {
        tags: ["Governance"],
        summary: "List registered governance backends",
        response: { 200: envelopeKeyArray("backends") },
      },
    },
    async () => {
      const checkpoints = await fastify.coordinatorStore.listProjections<GovernanceCheckpointView>(GOVERNANCE_CHECKPOINT);
      const backends = buildBackendReadModels(
        fastify.governanceBackendRegistry.listDescriptors(),
        checkpoints,
      );
      return ok({ backends });
    },
  );

  // ── POST /governance/dev/seed-demo ────────────────────────────────────────
  fastify.post(
    "/governance/dev/seed-demo",
    {
      schema: {
        tags: ["Governance"],
        summary: "Seed Phase D.5 demo governance projections (dev only)",
        response: { 200: envelope(), 403: errorEnvelope },
      },
    },
    async () => {
      if (!fastify.config.enableDevRoutes) {
        throw forbidden("Dev routes are disabled");
      }

      const seeded = await seedPhaseD5GovernanceDemo(fastify);
      return ok(seeded);
    },
  );

  // ── GET /governance/merged/:id ─────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    "/governance/merged/:id",
    {
      schema: {
        tags: ["Governance"],
        summary: "Get a single merged governance view",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: { 200: envelopeKey("merged") },
      },
    },
    async (request) => {
      const rawId = request.params.id;
      // rawId may be "merged:intent-xxx" or just "intent-xxx" or a subjectId
      const intentId = rawId.startsWith("merged:") ? rawId.slice(7) : rawId;

      const intent = await fastify.coordinatorStore.getProjection<{
        id: string; projectId?: string; title?: string; status?: string; proposedBy?: string; createdAt?: string;
      }>("governance_intent", intentId);

      const allLinksMerged = await fastify.coordinatorStore.listProjections<GovernanceIntentChainLink>(
        GOVERNANCE_INTENT_CHAIN_LINK,
      );
      const link = allLinksMerged.find((l) => l.governanceIntentId === intentId);

      const subject = link
        ? await fastify.coordinatorStore.getProjection<GovernanceSubjectView>(GOVERNANCE_SUBJECT_VIEW, link.subjectId)
        : await fastify.coordinatorStore.getProjection<GovernanceSubjectView>(GOVERNANCE_SUBJECT_VIEW, intentId);

      if (!intent && !subject) throw notFound("GovernanceMergedView", rawId);

      const allVotesMerged = await fastify.coordinatorStore.listProjections<GovernanceVoteActivityView>(
        GOVERNANCE_VOTE_ACTIVITY,
      );
      const votes = subject ? allVotesMerged.filter((v) => v.subjectId === subject.id) : [];
      const allRcMerged = await fastify.coordinatorStore.listProjections<GovernanceTxReceiptProjection>(
        GOVERNANCE_TX_RECEIPT,
      );
      const actionReceipts = allRcMerged.filter(
        (receipt) => receipt.intentId === intent?.id || receipt.subjectId === subject?.id,
      );

      const checkpoints = await fastify.coordinatorStore.listProjections<GovernanceCheckpointView>(GOVERNANCE_CHECKPOINT);
      const checkpoint = selectCheckpointForGovernanceView(checkpoints, subject, link);

      const merged = enrichMergedViewObservability({
        base: buildMergedView({
          id: rawId,
          projectId: intent?.projectId,
          intent: intent ? { id: intent.id, title: intent.title, status: intent.status } : undefined,
          subject,
          votes,
          link,
          checkpoint,
        }),
        receipts: actionReceipts,
        intentId: intent?.id,
        subjectId: subject?.id,
        votes,
      });

      return ok({ merged });
    },
  );

  // ── POST /governance/intents/:governanceIntentId/link-subject ──────────────
  fastify.post<{
    Params: { governanceIntentId: string };
    Body: { subjectId: string; externalId?: string; backend?: string; linkSource?: string; confidence?: string; metadata?: Record<string, unknown> };
  }>(
    "/governance/intents/:governanceIntentId/link-subject",
    {
      schema: {
        tags: ["Governance"],
        summary: "Link a governance intent to an on-chain subject",
        params: {
          type: "object",
          required: ["governanceIntentId"],
          properties: { governanceIntentId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["subjectId"],
          properties: {
            subjectId: { type: "string" },
            externalId: { type: "string" },
            backend: { type: "string" },
            linkSource: { type: "string", enum: ["explicit", "tx_receipt", "metadata_match", "manual"], default: "explicit" },
            confidence: { type: "string", enum: ["high", "medium", "low"], default: "high" },
            metadata: { type: "object" },
          },
        },
        response: { 200: envelopeKey("link") },
      },
    },
    async (request) => {
      const { governanceIntentId } = request.params;
      const intent = await fastify.coordinatorStore.getProjection("governance_intent", governanceIntentId);
      if (!intent) throw notFound("GovernanceIntent", governanceIntentId);

      const now = new Date().toISOString();
      const linkId = `link:${governanceIntentId}:${request.body.subjectId}`;
      const subject = await fastify.coordinatorStore.getProjection<GovernanceSubjectView>(
        GOVERNANCE_SUBJECT_VIEW,
        request.body.subjectId,
      );

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
      await fastify.coordinatorStore.saveProjection(GOVERNANCE_INTENT_CHAIN_LINK, linkId, link);
      return ok({ link });
    },
  );

  // ── POST /governance/intents/:governanceIntentId/reconcile-subject ────────
  fastify.post<{
    Params: { governanceIntentId: string };
    Body: { subjectId?: string; externalId?: string; metadata?: Record<string, unknown> };
  }>(
    "/governance/intents/:governanceIntentId/reconcile-subject",
    {
      schema: {
        tags: ["Governance"],
        summary: "Reconcile a submitted governance intent with an indexed OpenGov subject",
        params: {
          type: "object",
          required: ["governanceIntentId"],
          properties: { governanceIntentId: { type: "string" } },
        },
        body: {
          type: "object",
          properties: {
            subjectId: { type: "string" },
            externalId: { type: "string" },
            metadata: { type: "object" },
          },
        },
        response: { 200: envelope() },
      },
    },
    async (request) => {
      const intent = await fastify.coordinatorStore.getProjection<{
        id: string;
        status: string;
        submitReceiptId?: string;
        readbackStatus?: string;
      }>("governance_intent", request.params.governanceIntentId);
      if (!intent) throw notFound("GovernanceIntent", request.params.governanceIntentId);

      const allSubjects = await fastify.coordinatorStore.listProjections<GovernanceSubjectView>(GOVERNANCE_SUBJECT_VIEW);
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
      await fastify.coordinatorStore.saveProjection(GOVERNANCE_INTENT_CHAIN_LINK, link.id, link);

      const allReconcileReceipts = await fastify.coordinatorStore.listProjections<GovernanceTxReceiptProjection>(
        GOVERNANCE_TX_RECEIPT,
      );
      const receipts = allReconcileReceipts.filter((receipt) => receipt.intentId === intent.id);
      for (const receipt of receipts) {
        await fastify.coordinatorStore.saveProjection(GOVERNANCE_TX_RECEIPT, receipt.id, {
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
      await fastify.coordinatorStore.saveProjection("governance_intent", intent.id, updated);

      return ok({ governanceIntent: updated, link, receipts: receipts.length });
    },
  );
};

export default governanceRoutes;

async function createSubstrateGovernanceActionsAdapter(fastify: Parameters<FastifyPluginAsync>[0]) {
  const { SubstrateGovernanceActionsAdapter } = await import("@concord/adapter-substrate-actions");
  const config: ConstructorParameters<typeof SubstrateGovernanceActionsAdapter>[0] = {
    rpcUrl: fastify.config.substrateRpcUrl,
    chainId: fastify.config.substrateChainId,
  };
  if (fastify.config.substrateGovernanceTxMode === "fixture") {
    config.submitter = async (input) => ({
      txHash: `0xphasee_${input.call}_${Date.now().toString(16)}`,
      chain: input.chain,
      finality: "included" as const,
    });
  }
  return new SubstrateGovernanceActionsAdapter(config);
}

async function saveGovernanceTxReceipt(
  fastify: Parameters<FastifyPluginAsync>[0],
  input: {
    intentId?: string;
    subjectId?: string;
    action: GovernanceTxReceiptProjection["action"];
    chain: ChainRef;
    actor: string;
    tx: TxReceipt;
    payloadSummary?: Record<string, unknown>;
    readbackStatus: GovernanceTxReceiptProjection["readbackStatus"];
  },
): Promise<GovernanceTxReceiptProjection> {
  const now = new Date().toISOString();
  const id = `governance-tx:${input.action}:${input.tx.txHash}`;
  const receipt: GovernanceTxReceiptProjection = {
    id,
    action: input.action,
    backend: "substrate-opengov",
    chain: input.chain,
    actor: input.actor,
    tx: input.tx,
    readbackStatus: input.readbackStatus,
    createdAt: now,
    updatedAt: now,
  };
  if (input.intentId !== undefined) receipt.intentId = input.intentId;
  if (input.subjectId !== undefined) receipt.subjectId = input.subjectId;
  if (input.payloadSummary !== undefined) receipt.payloadSummary = input.payloadSummary;
  await fastify.coordinatorStore.saveProjection(GOVERNANCE_TX_RECEIPT, id, receipt);
  return receipt;
}

async function maybeLinkSubmittedIntent(
  fastify: Parameters<FastifyPluginAsync>[0],
  input: {
    intentId: string;
    chain: ChainRef;
    externalId?: string;
    subjectId?: string;
    tx: TxReceipt;
  },
): Promise<GovernanceIntentChainLink | null> {
  const externalId = input.externalId ?? input.subjectId;
  if (!externalId) return null;
  const now = new Date().toISOString();
  const subjectId = input.subjectId ?? `${input.chain.namespace}:${input.chain.chainId}:${externalId}`;
  const link: GovernanceIntentChainLink = {
    id: `link:${input.intentId}:${subjectId}`,
    governanceIntentId: input.intentId,
    subjectId,
    chain: input.chain,
    backend: "substrate-opengov",
    externalId,
    linkSource: input.subjectId ? "explicit" : "tx_receipt",
    confidence: input.subjectId ? "high" : "medium",
    createdAt: now,
    updatedAt: now,
    metadata: { txHash: input.tx.txHash, readbackStatus: "pending_indexer" },
  };
  await fastify.coordinatorStore.saveProjection(GOVERNANCE_INTENT_CHAIN_LINK, link.id, link);
  return link;
}

function selectReceiptsForGovernanceView(
  receipts: GovernanceTxReceiptProjection[],
  intentId?: string,
  subjectId?: string,
): GovernanceTxReceiptProjection[] {
  return receipts
    .filter((receipt) => (
      (intentId !== undefined && receipt.intentId === intentId) ||
      (subjectId !== undefined && receipt.subjectId === subjectId)
    ))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function findGovernanceSubjectForReconciliation(
  subjects: GovernanceSubjectView[],
  input: { subjectId?: string; externalId?: string },
): GovernanceSubjectView | undefined {
  if (input.subjectId) {
    return subjects.find((subject) => subject.id === input.subjectId);
  }
  if (input.externalId) {
    return subjects.find((subject) => (
      subject.backend === "substrate-opengov" &&
      subject.externalId === input.externalId
    ));
  }
  return undefined;
}

function enrichMergedViewObservability(input: {
  base: ReturnType<typeof buildMergedView>;
  receipts: GovernanceTxReceiptProjection[];
  intentId?: string;
  subjectId?: string;
  votes?: GovernanceVoteActivityView[];
}) {
  const actionReceipts = selectReceiptsForGovernanceView(input.receipts, input.intentId, input.subjectId);
  const submitReceipt = actionReceipts.find((receipt) => receipt.action === "submitProposal");
  const voteReceipts = actionReceipts.filter((receipt) => receipt.action === "castVote");
  const indexedVotes = input.votes ?? input.base.votes ?? [];
  const linked = Boolean(input.base.subject && input.base.link);
  const pendingReadback = actionReceipts.some((receipt) => receipt.readbackStatus === "pending_indexer") && !linked;
  return {
    ...input.base,
    actionReceipts,
    submitReceipt,
    voteReceipts,
    readbackStatus: linked ? "linked" : (actionReceipts[0]?.readbackStatus ?? "not_submitted"),
    readback: {
      pending: pendingReadback,
      linked,
      linkedSubjectId: input.base.subject?.id,
      submitTxHash: submitReceipt?.tx.txHash,
      voteReceiptCount: voteReceipts.length,
      indexedVoteCount: indexedVotes.length,
      voteReadbackStatus: computeVoteReadbackStatus(voteReceipts, indexedVotes),
    },
  };
}

function computeVoteReadbackStatus(
  voteReceipts: GovernanceTxReceiptProjection[],
  votes: GovernanceVoteActivityView[],
): "not_submitted" | "pending_indexer" | "indexed" {
  if (voteReceipts.length === 0) return "not_submitted";
  if (votes.length > 0) return "indexed";
  return "pending_indexer";
}

function summarizePayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  return {
    type: record["type"],
    pallet: record["pallet"],
    call: record["call"],
  };
}

function selectCheckpointForGovernanceView(
  checkpoints: GovernanceCheckpointView[],
  subject?: GovernanceSubjectView,
  link?: GovernanceIntentChainLink,
): GovernanceCheckpointView | undefined {
  const chain = subject?.chain ?? link?.chain;
  if (chain) {
    const matching = checkpoints
      .filter((checkpoint) => chainsEqual(checkpoint.chain, chain))
      .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime());
    return matching[0];
  }

  return checkpoints
    .slice()
    .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())[0];
}

function buildBackendReadModels(
  descriptors: GovernanceBackendDescriptor[],
  checkpoints: GovernanceCheckpointView[],
): GovernanceBackendReadModel[] {
  return descriptors.map((descriptor) => ({
    ...descriptor,
    health: buildBackendHealth(descriptor, checkpoints),
  }));
}

async function seedPhaseD5GovernanceDemo(fastify: Parameters<FastifyPluginAsync>[0]) {
  const now = new Date().toISOString();
  const substrateChain = {
    namespace: "substrate" as const,
    chainId: fastify.config.substrateChainId ?? "substrate:vibly-solo",
  };
  const evmChain = {
    namespace: "eip155" as const,
    chainId: fastify.config.evmChainId ?? "31337",
  };

  const projection = {
    version: "phase-d5-demo",
    hash: "phase-d5-demo-seed",
    projectedAt: now,
    projector: "vibly-coordinator:dev-seed",
  };
  const source = { adapter: "phase-d5-demo-seed" };

  const subjects: GovernanceSubjectView[] = [
    {
      id: `${substrateChain.namespace}:${substrateChain.chainId}:demo-open-gov-1`,
      chain: substrateChain,
      backend: "substrate-opengov",
      externalId: "demo-open-gov-1",
      title: "Phase D.5 Substrate OpenGov demo",
      status: "Deciding",
      lifecycle: { discoveredAt: now, updatedAt: now },
      finality: "included",
      source,
      projection,
      metadata: { seed: "phase-d5", track: "root" },
    },
    {
      id: `${evmChain.namespace}:${evmChain.chainId}:demo-evm-governor-1`,
      chain: evmChain,
      backend: "evm-governor",
      externalId: "demo-evm-governor-1",
      title: "Phase D.5 EVM Governor fixture demo",
      status: "Deciding",
      lifecycle: { discoveredAt: now, updatedAt: now },
      finality: "included",
      source,
      projection,
      metadata: { seed: "phase-d5", fixture: true },
    },
  ];

  const checkpoints: GovernanceCheckpointView[] = [
    {
      id: `checkpoint:${substrateChain.namespace}:${substrateChain.chainId}`,
      chain: substrateChain,
      cursor: { position: "phase-d5-demo-substrate", blockNumber: "1" },
      finalized: false,
      observedAt: now,
      source,
      projection,
    },
    {
      id: `checkpoint:${evmChain.namespace}:${evmChain.chainId}`,
      chain: evmChain,
      cursor: { position: "phase-d5-demo-evm", blockNumber: "1" },
      finalized: false,
      observedAt: now,
      source,
      projection,
    },
  ];

  for (const subject of subjects) {
    await fastify.coordinatorStore.saveProjection(GOVERNANCE_SUBJECT_VIEW, subject.id, subject);
  }
  for (const checkpoint of checkpoints) {
    await fastify.coordinatorStore.saveProjection(GOVERNANCE_CHECKPOINT, checkpoint.id, checkpoint);
  }

  return { subjects, checkpoints };
}

function buildBackendHealth(
  descriptor: GovernanceBackendDescriptor,
  checkpoints: GovernanceCheckpointView[],
): GovernanceBackendHealth {
  const checkpoint = selectCheckpointForChain(checkpoints, descriptor.chain);
  if (!checkpoint) {
    return {
      status: "unavailable",
      stale: true,
      reason: "checkpoint_missing",
    };
  }

  const stale = isCheckpointStale(checkpoint);
  const health: GovernanceBackendHealth = {
    status: stale ? "stale" : "healthy",
    stale,
    lastObservedAt: checkpoint.observedAt,
    checkpoint,
  };
  if (stale) health.reason = "checkpoint_age_exceeds_threshold";
  return health;
}

function selectCheckpointForChain(
  checkpoints: GovernanceCheckpointView[],
  chain: { namespace?: string; chainId?: string },
): GovernanceCheckpointView | undefined {
  return checkpoints
    .filter((checkpoint) => chainsEqual(checkpoint.chain, chain))
    .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())[0];
}

function chainsEqual(
  left: { namespace?: string; chainId?: string },
  right: { namespace?: string; chainId?: string },
): boolean {
  return left.namespace === right.namespace && left.chainId === right.chainId;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
