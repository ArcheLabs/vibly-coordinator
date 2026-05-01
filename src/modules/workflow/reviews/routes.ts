import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { envelope, envelopeKey, listEnvelope } from "../../../domain/schemas.js";

const reviewsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /reviews/requests
  fastify.post<{
    Body: {
      target: { kind: string; submissionId?: string; candidateId?: string; actionId?: string };
      requestedBy: string;
    };
  }>(
    "/reviews/requests",
    {
      schema: {
        tags: ["Reviews"],
        summary: "Request a review",
        body: {
          type: "object",
          required: ["target", "requestedBy"],
          properties: {
            target: { type: "object" },
            requestedBy: { type: "string" },
          },
        },
        response: { 200: envelope() },
      },
    },
    async (request) => {
      await fastify.concord.review.requestReview({
        target: request.body.target as never,
        requestedBy: request.body.requestedBy as never,
      });
      return ok({ requested: true });
    },
  );

  // POST /reviews
  fastify.post<{
    Body: {
      target: { kind: string; submissionId?: string; candidateId?: string; actionId?: string };
      reviewerId: string;
      result: string;
      score?: number;
      rationale: string;
      evidence?: unknown[];
      contextBundleId: string;
    };
  }>(
    "/reviews",
    {
      schema: {
        tags: ["Reviews"],
        summary: "Submit a review",
        body: {
          type: "object",
          required: ["target", "reviewerId", "result", "rationale", "contextBundleId"],
          properties: {
            target: { type: "object" },
            reviewerId: { type: "string" },
            result: { type: "string" },
            score: { type: "number" },
            rationale: { type: "string" },
            evidence: { type: "array" },
            contextBundleId: { type: "string" },
          },
        },
        response: { 200: envelopeKey("review") },
      },
    },
    async (request) => {
      const bundle = await fastify.concord.context.getBundle(request.body.contextBundleId);
      if (!bundle) throw notFound("ContextBundle", request.body.contextBundleId);
      const { receiptFromBundle } = await import("@concord/adapters");
      const contextReceipt = receiptFromBundle(bundle, request.body.reviewerId as never);

      const review = await fastify.concord.review.submitReview({
        target: request.body.target as never,
        reviewerId: request.body.reviewerId as never,
        result: request.body.result as never,
        score: request.body.score,
        rationale: request.body.rationale,
        evidence: (request.body.evidence ?? []) as never,
        contextReceipt,
      });
      fastify.eventBus.publish({ type: "ReviewSubmitted", payload: review } as never);
      return ok({ review });
    },
  );

  // GET /reviews
  fastify.get<{ Querystring: { targetKind?: string; reviewerId?: string; result?: string; limit?: string; cursor?: string } }>(
    "/reviews",
    {
      schema: {
        tags: ["Reviews"],
        summary: "List reviews",
        querystring: {
          type: "object",
          properties: {
            targetKind: { type: "string" },
            reviewerId: { type: "string" },
            result: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: { 200: listEnvelope() },
      },
    },
    async (request) => {
      const { targetKind, reviewerId, result, limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);
      const events = await fastify.concord.state.events.query({ type: ["ReviewSubmitted"] });
      let reviews = events.map((e) => e.payload as { id: string; target: { kind: string }; reviewerId: string; result: string });
      if (targetKind) reviews = reviews.filter((r) => r.target?.kind === targetKind);
      if (reviewerId) reviews = reviews.filter((r) => String(r.reviewerId) === reviewerId);
      if (result) reviews = reviews.filter((r) => r.result === result);

      let startIdx = 0;
      if (cursor) {
        const idx = reviews.findIndex((r) => r.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = reviews.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // POST /reviews/aggregate
  fastify.post<{
    Body: { target: { kind: string; submissionId?: string; candidateId?: string; actionId?: string } };
  }>(
    "/reviews/aggregate",
    {
      schema: {
        tags: ["Reviews"],
        summary: "Aggregate reviews for a target",
        body: {
          type: "object",
          required: ["target"],
          properties: { target: { type: "object" } },
        },
        response: { 200: envelopeKey("aggregation") },
      },
    },
    async (request) => {
      const aggregation = await fastify.concord.review.aggregate({
        target: request.body.target as never,
      });
      return ok({ aggregation });
    },
  );
};

export default reviewsRoutes;
