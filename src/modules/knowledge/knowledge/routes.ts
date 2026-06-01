import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { envelopeKey, listEnvelope } from "../../../domain/schemas.js";

const knowledgeRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /knowledge/latest
  fastify.get(
    "/knowledge/latest",
    {
      schema: {
        tags: ["Knowledge"],
        summary: "Get the latest knowledge version",
        response: { 200: envelopeKey("knowledgeVersion") },
      },
    },
    async () => {
      const version = await fastify.concord.knowledge.getLatestVersion();
      return ok({ knowledgeVersion: version });
    },
  );

  // GET /knowledge/versions/:versionId
  fastify.get<{ Params: { versionId: string } }>(
    "/knowledge/versions/:versionId",
    {
      schema: {
        tags: ["Knowledge"],
        summary: "Get a knowledge version",
        params: { type: "object", required: ["versionId"], properties: { versionId: { type: "string" } } },
        response: { 200: envelopeKey("knowledgeVersion") },
      },
    },
    async (request) => {
      const version = await fastify.concord.knowledge.getVersion(request.params.versionId as never);
      if (!version) throw notFound("KnowledgeVersion", request.params.versionId);
      return ok({ knowledgeVersion: version });
    },
  );

  // GET /knowledge/versions — list by scanning events
  fastify.get<{ Querystring: { limit?: string; cursor?: string } }>(
    "/knowledge/versions",
    {
      schema: {
        tags: ["Knowledge"],
        summary: "List knowledge versions",
        querystring: {
          type: "object",
          properties: { limit: { type: "string" }, cursor: { type: "string" } },
        },
        response: { 200: listEnvelope() },
      },
    },
    async (request) => {
      const { limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);
      const events = await fastify.concord.state.events.query({ type: ["KnowledgeCommitted"] });
      const versions = events.map((e) => e.payload as { id: string });

      let startIdx = 0;
      if (cursor) {
        const idx = versions.findIndex((v) => v.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = versions.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // POST /knowledge/candidates — propose a knowledge candidate
  fastify.post<{
    Body: {
      proposedBy: string;
      source: { uri: string; mediaType?: string };
      summary?: string;
      targetLayer?: string;
      contextBundleId?: string;
    };
  }>(
    "/knowledge/candidates",
    {
      schema: {
        tags: ["Knowledge"],
        summary: "Propose a knowledge candidate",
        body: {
          type: "object",
          required: ["proposedBy", "source"],
          properties: {
            proposedBy: { type: "string" },
            source: { type: "object", properties: { uri: { type: "string" }, mediaType: { type: "string" } } },
            summary: { type: "string" },
            targetLayer: { type: "string" },
            contextBundleId: { type: "string" },
          },
        },
        response: { 200: envelopeKey("candidate") },
      },
    },
    async (request) => {
      const contextBundle = request.body.contextBundleId
        ? await fastify.concord.context.getBundle(request.body.contextBundleId)
        : null;
      const { makeId, nowTimestamp } = await import("@vibly-ai/concord-foundation");
      const candidate = {
        id: makeId("KnowledgeCandidateId"),
        proposedBy: request.body.proposedBy as never,
        source: request.body.source as never,
        summary: request.body.summary,
        targetLayer: (request.body.targetLayer ?? "formal") as never,
        context: (contextBundle ? { contextBundleId: contextBundle.id } : {}) as never,
        createdAt: nowTimestamp(),
      };
      await fastify.concord.knowledge.saveCandidate(candidate);
      const { createEvent } = await import("@vibly-ai/concord-foundation");
      const evt = createEvent({ type: "KnowledgeCandidateProposed", payload: candidate });
      await fastify.concord.state.events.append(evt);
      fastify.eventBus.publish(evt);
      return ok({ candidate });
    },
  );

  // GET /knowledge/candidates/:candidateId
  fastify.get<{ Params: { candidateId: string } }>(
    "/knowledge/candidates/:candidateId",
    {
      schema: {
        tags: ["Knowledge"],
        summary: "Get a knowledge candidate",
        params: { type: "object", required: ["candidateId"], properties: { candidateId: { type: "string" } } },
        response: { 200: envelopeKey("candidate") },
      },
    },
    async (request) => {
      const candidate = await fastify.concord.knowledge.getCandidate(request.params.candidateId as never);
      if (!candidate) throw notFound("KnowledgeCandidate", request.params.candidateId);
      return ok({ candidate });
    },
  );

  // POST /knowledge/commits — commit candidates into a new version
  fastify.post<{
    Body: {
      candidateIds: string[];
      decisionRecordId: string;
      parentVersionId: string;
      createdBy: string;
    };
  }>(
    "/knowledge/commits",
    {
      schema: {
        tags: ["Knowledge"],
        summary: "Commit knowledge candidates into a new version",
        body: {
          type: "object",
          required: ["candidateIds", "decisionRecordId", "parentVersionId", "createdBy"],
          properties: {
            candidateIds: { type: "array", items: { type: "string" } },
            decisionRecordId: { type: "string" },
            parentVersionId: { type: "string" },
            createdBy: { type: "string" },
          },
        },
        response: { 200: envelopeKey("knowledgeVersion") },
      },
    },
    async (request) => {
      const version = await fastify.concord.knowledge.commit({
        candidateIds: request.body.candidateIds as never,
        decisionRecordId: request.body.decisionRecordId as never,
        parentVersionId: request.body.parentVersionId as never,
        createdBy: request.body.createdBy as never,
      });
      const { createEvent } = await import("@vibly-ai/concord-foundation");
      const evt = createEvent({ type: "KnowledgeCommitted", payload: version });
      await fastify.concord.state.events.append(evt);
      fastify.eventBus.publish(evt);
      return ok({ knowledgeVersion: version });
    },
  );
};

export default knowledgeRoutes;
