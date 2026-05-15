/**
 * GET /organizations — Organization read-model routes.
 *
 * All writes go through POST /action-intents.
 */

import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";
import { envelope, envelopeKey, envelopeKeyArray, listEnvelope } from "../../domain/schemas.js";
import { OrganizationRepository } from "../../contexts/organization/repository.js";
import { authPolicy } from "../../plugins/authPolicy.js";

const organizationsRoutes: FastifyPluginAsync = async (fastify) => {
  // ─── List organizations ────────────────────────────────────────────────

  fastify.get<{ Querystring: { limit?: number; cursor?: string } }>(
    "/organizations",
    {
      ...authPolicy("public-read", {
        tags: ["Organizations"],
        summary: "List organizations",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            cursor: { type: "string" },
          },
        },
        response: {
          200: listEnvelope({
            type: "object",
            required: ["id", "name", "status", "memberCount", "createdAt"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              description: { type: "string" },
              status: { type: "string" },
              memberCount: { type: "integer" },
              createdAt: { type: "string" },
              updatedAt: { type: "string" },
            },
          }),
        },
      }),
    },
    async (request) => {
      const repo = new OrganizationRepository(fastify.coordinatorStore);
      const limit = request.query.limit ?? 50;
      const overviews = await repo.listOverviews();
      const page = overviews.slice(0, limit);
      return {
        ok: true as const,
        data: page,
        page: { limit, nextCursor: page.length < limit ? null : (page[page.length - 1]?.id ?? null) },
        meta: { requestId: (fastify as unknown as { genReqId?: () => string }).genReqId?.() ?? "req" },
      };
    },
  );

  // ─── Get organization ────────────────────────────────────────────────────

  fastify.get<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId",
    {
      ...authPolicy("public-read", {
        tags: ["Organizations"],
        summary: "Get organization by ID",
        params: {
          type: "object",
          required: ["organizationId"],
          properties: { organizationId: { type: "string" } },
        },
        response: {
          200: envelopeKey("organization", {
            type: "object",
            required: ["id", "name", "status", "members", "authorities", "createdAt"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              description: { type: "string" },
              status: { type: "string" },
              handbook: { type: "object", additionalProperties: true },
              members: { type: "array", items: { type: "object", additionalProperties: true } },
              authorities: { type: "array", items: { type: "object", additionalProperties: true } },
              createdBy: { type: "string" },
              createdAt: { type: "string" },
              updatedAt: { type: "string" },
            },
          }),
        },
      }),
    },
    async (request) => {
      const repo = new OrganizationRepository(fastify.coordinatorStore);
      const org = await repo.get(request.params.organizationId);
      if (!org) throw notFound("Organization", request.params.organizationId);
      return ok({ organization: org });
    },
  );

  // ─── Organization feed ────────────────────────────────────────────────────

  fastify.get<{ Params: { organizationId: string }; Querystring: { limit?: number } }>(
    "/organizations/:organizationId/feed",
    {
      ...authPolicy("public-read", {
        tags: ["Organizations"],
        summary: "Get organization activity feed",
        params: {
          type: "object",
          required: ["organizationId"],
          properties: { organizationId: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
        },
        response: {
          200: envelopeKeyArray("items", {
            type: "object",
            required: ["feedEventId", "eventType", "organizationId", "summary", "createdAt"],
            properties: {
              feedEventId: { type: "string" },
              eventType: { type: "string" },
              organizationId: { type: "string" },
              projectId: { type: "string" },
              actorId: { type: "string" },
              subject: { type: "object", additionalProperties: true },
              summary: { type: "string" },
              payload: { type: "object", additionalProperties: true },
              createdAt: { type: "string" },
            },
          }),
        },
      }),
    },
    async (request) => {
      const repo = new OrganizationRepository(fastify.coordinatorStore);
      const org = await repo.get(request.params.organizationId);
      if (!org) throw notFound("Organization", request.params.organizationId);
      const limit = request.query.limit ?? 50;
      const items = await repo.listFeed(request.params.organizationId, limit);
      return ok({ items });
    },
  );

  // ─── Global feed ─────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { limit?: number } }>(
    "/feed",
    {
      ...authPolicy("public-read", {
        tags: ["Feed"],
        summary: "Global activity feed across all organizations",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
        },
        response: {
          200: envelopeKeyArray("items", {
            type: "object",
            required: ["feedEventId", "eventType", "organizationId", "summary", "createdAt"],
            properties: {
              feedEventId: { type: "string" },
              eventType: { type: "string" },
              organizationId: { type: "string" },
              projectId: { type: "string" },
              actorId: { type: "string" },
              subject: { type: "object", additionalProperties: true },
              summary: { type: "string" },
              payload: { type: "object", additionalProperties: true },
              createdAt: { type: "string" },
            },
          }),
        },
      }),
    },
    async (request) => {
      const repo = new OrganizationRepository(fastify.coordinatorStore);
      const limit = request.query.limit ?? 50;
      const items = await repo.listGlobalFeed(limit);
      return ok({ items });
    },
  );

  // ─── Feed event detail ────────────────────────────────────────────────────

  fastify.get<{ Params: { feedEventId: string } }>(
    "/feed/:feedEventId",
    {
      ...authPolicy("public-read", {
        tags: ["Feed"],
        summary: "Get feed event detail",
        params: {
          type: "object",
          required: ["feedEventId"],
          properties: { feedEventId: { type: "string" } },
        },
        response: {
          200: envelopeKey("feedItem", {
            type: "object",
            required: ["feedEventId", "eventType", "organizationId", "summary", "createdAt"],
            properties: {
              feedEventId: { type: "string" },
              eventType: { type: "string" },
              organizationId: { type: "string" },
              projectId: { type: "string" },
              actorId: { type: "string" },
              subject: { type: "object", additionalProperties: true },
              summary: { type: "string" },
              payload: { type: "object", additionalProperties: true },
              createdAt: { type: "string" },
            },
          }),
        },
      }),
    },
    async (request) => {
      const repo = new OrganizationRepository(fastify.coordinatorStore);
      // Feed items are stored with feedEventId as key in the global KIND_FEED projection
      const allItems = await repo.listGlobalFeed(10000);
      const item = allItems.find((i) => i.feedEventId === request.params.feedEventId);
      if (!item) throw notFound("FeedItem", request.params.feedEventId);
      return ok({ feedItem: item });
    },
  );
};

export default organizationsRoutes;
