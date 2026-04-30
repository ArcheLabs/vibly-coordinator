import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";
import {
  GOVERNANCE_SUBJECT_VIEW,
  GOVERNANCE_VOTE_ACTIVITY,
  GOVERNANCE_DELEGATION,
  GOVERNANCE_CHECKPOINT,
  GOVERNANCE_INTENT_CHAIN_LINK,
} from "../../db/projectionKinds.js";
import { buildMergedView } from "./mergeBuilder.js";
import type {
  GovernanceSubjectView,
  GovernanceVoteActivityView,
  GovernanceDelegationView,
  GovernanceCheckpointView,
  GovernanceIntentChainLink,
} from "@concord/governance";

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
      fastify.coordinatorStore.saveProjection("governance_intent", String(intent.id), intent);
      const evt = createEvent({ type: "GovernanceIntentCreated", payload: intent });
      await fastify.concord.state.events.append(evt);
      fastify.eventBus.publish(evt);
      return ok({ governanceIntent: intent });
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
      },
    },
    async (request) => {
      const intent = fastify.coordinatorStore.getProjection("governance_intent", request.params.governanceIntentId);
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
      },
    },
    async (request, reply) => {
      const intent = fastify.coordinatorStore.getProjection<{
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
      fastify.coordinatorStore.saveProjection("governance_intent", intent.id, updated);

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
      },
    },
    async () => {
      const items = fastify.coordinatorStore.listProjections("governance_view") as unknown[];
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
      },
    },
    async (request) => {
      const view = fastify.coordinatorStore.getProjection("governance_view", request.params.subjectId);
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
      },
    },
    async (request) => {
      const { backend, chainId } = request.query;
      const storedCheckpoints = fastify.coordinatorStore.listProjections<GovernanceCheckpointView>(GOVERNANCE_CHECKPOINT);
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
      },
    },
    async (request) => {
      const { chainId, status, backend, limit = 50 } = request.query;
      let items = fastify.coordinatorStore.listProjections<GovernanceSubjectView>(GOVERNANCE_SUBJECT_VIEW);
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
      },
    },
    async (request) => {
      const view = fastify.coordinatorStore.getProjection<GovernanceSubjectView>(
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
      },
    },
    async (request) => {
      const all = fastify.coordinatorStore.listProjections<GovernanceVoteActivityView>(GOVERNANCE_VOTE_ACTIVITY);
      const items = all.filter((v) => v.subjectId === request.params.subjectId);
      return ok({ items });
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
      },
    },
    async (request) => {
      const { chainId, limit = 50 } = request.query;
      let items = fastify.coordinatorStore.listProjections<GovernanceDelegationView>(GOVERNANCE_DELEGATION);
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
      },
    },
    async (request) => {
      const { projectId, backend, limit = 50 } = request.query;
      const intents = fastify.coordinatorStore
        .listProjections<{ id: string; projectId?: string; title?: string; status?: string; proposedBy?: string; createdAt?: string }>("governance_intent")
        .filter((i) => !projectId || i.projectId === projectId);

      const subjects = fastify.coordinatorStore.listProjections<GovernanceSubjectView>(GOVERNANCE_SUBJECT_VIEW);
      const links = fastify.coordinatorStore.listProjections<GovernanceIntentChainLink>(GOVERNANCE_INTENT_CHAIN_LINK);
      const checkpoints = fastify.coordinatorStore.listProjections<GovernanceCheckpointView>(GOVERNANCE_CHECKPOINT);

      const merged = intents.slice(0, limit).map((intent) => {
        const link = links.find((l) => l.governanceIntentId === intent.id);
        const subject = link ? subjects.find((s) => s.id === link.subjectId) : undefined;
        const checkpoint = selectCheckpointForGovernanceView(checkpoints, subject, link);
        return buildMergedView({
          id: `merged:${intent.id}`,
          projectId: intent.projectId,
          intent: { id: intent.id, title: intent.title, status: intent.status, proposedBy: intent.proposedBy, createdAt: intent.createdAt },
          subject,
          link,
          checkpoint,
        });
      });

      // Also include subjects without intents (orphan chain subjects)
      const linkedSubjectIds = new Set(links.map((l) => l.subjectId));
      for (const subject of subjects) {
        if (!linkedSubjectIds.has(subject.id) && merged.length < limit) {
          const checkpoint = selectCheckpointForGovernanceView(checkpoints, subject);
          merged.push(buildMergedView({
            id: `merged:${subject.id}`,
            subject,
            checkpoint,
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
      },
    },
    async () => {
      const backends = fastify.governanceBackendRegistry.listDescriptors();
      return ok({ backends });
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
      },
    },
    async (request) => {
      const rawId = request.params.id;
      // rawId may be "merged:intent-xxx" or just "intent-xxx" or a subjectId
      const intentId = rawId.startsWith("merged:") ? rawId.slice(7) : rawId;

      const intent = fastify.coordinatorStore.getProjection<{
        id: string; projectId?: string; title?: string; status?: string; proposedBy?: string; createdAt?: string;
      }>("governance_intent", intentId);

      const link = fastify.coordinatorStore
        .listProjections<GovernanceIntentChainLink>(GOVERNANCE_INTENT_CHAIN_LINK)
        .find((l) => l.governanceIntentId === intentId);

      const subject = link
        ? fastify.coordinatorStore.getProjection<GovernanceSubjectView>(GOVERNANCE_SUBJECT_VIEW, link.subjectId)
        : fastify.coordinatorStore.getProjection<GovernanceSubjectView>(GOVERNANCE_SUBJECT_VIEW, intentId);

      if (!intent && !subject) throw notFound("GovernanceMergedView", rawId);

      const votes = subject
        ? fastify.coordinatorStore.listProjections<GovernanceVoteActivityView>(GOVERNANCE_VOTE_ACTIVITY)
            .filter((v) => v.subjectId === subject.id)
        : [];

      const checkpoints = fastify.coordinatorStore.listProjections<GovernanceCheckpointView>(GOVERNANCE_CHECKPOINT);
      const checkpoint = selectCheckpointForGovernanceView(checkpoints, subject, link);

      const merged = buildMergedView({
        id: rawId,
        projectId: intent?.projectId,
        intent: intent ? { id: intent.id, title: intent.title, status: intent.status } : undefined,
        subject,
        votes,
        link,
        checkpoint,
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
      },
    },
    async (request) => {
      const { governanceIntentId } = request.params;
      const intent = fastify.coordinatorStore.getProjection("governance_intent", governanceIntentId);
      if (!intent) throw notFound("GovernanceIntent", governanceIntentId);

      const now = new Date().toISOString();
      const linkId = `link:${governanceIntentId}:${request.body.subjectId}`;
      const subject = fastify.coordinatorStore.getProjection<GovernanceSubjectView>(
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
      fastify.coordinatorStore.saveProjection(GOVERNANCE_INTENT_CHAIN_LINK, linkId, link);
      return ok({ link });
    },
  );
};

export default governanceRoutes;

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

function chainsEqual(
  left: { namespace?: string; chainId?: string },
  right: { namespace?: string; chainId?: string },
): boolean {
  return left.namespace === right.namespace && left.chainId === right.chainId;
}
