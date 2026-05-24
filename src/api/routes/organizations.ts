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
import { ArtifactRepository } from "../../contexts/artifact/repository.js";
import { authPolicy } from "../../plugins/authPolicy.js";
import { checkJoinEligibility, checkExitEligibility } from "../../contexts/membership/eligibility.js";

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
              feedCount: { type: "integer" },
              artifactCount: { type: "integer" },
              createdAt: { type: "string" },
              updatedAt: { type: "string" },
            },
          }),
        },
      }),
    },
    async (request) => {
      const repo = new OrganizationRepository(fastify.coordinatorStore);
      const artifactRepo = new ArtifactRepository(fastify.coordinatorStore);
      const limit = request.query.limit ?? 50;
      const overviews = await repo.listOverviews();
      const page = overviews.slice(0, limit);

      // Compute feedCount and artifactCount per org in two batched queries.
      const [allFeed, allArtifacts] = await Promise.all([
        repo.listGlobalFeed(10_000),
        artifactRepo.list(),
      ]);

      const feedCountByOrg = new Map<string, number>();
      for (const item of allFeed) {
        feedCountByOrg.set(item.organizationId, (feedCountByOrg.get(item.organizationId) ?? 0) + 1);
      }
      const artifactCountByOrg = new Map<string, number>();
      for (const a of allArtifacts) {
        if (a.organizationId) {
          artifactCountByOrg.set(a.organizationId, (artifactCountByOrg.get(a.organizationId) ?? 0) + 1);
        }
      }

      const enriched = page.map((o) => ({
        ...o,
        feedCount: feedCountByOrg.get(o.id) ?? 0,
        artifactCount: artifactCountByOrg.get(o.id) ?? 0,
      }));

      return {
        ok: true as const,
        data: enriched,
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

  // ─── Join eligibility ─────────────────────────────────────────────────────

  const eligibilityCheckSchema = {
    type: "object",
    required: ["name", "status", "message"],
    properties: {
      name: { type: "string" },
      status: { type: "string", enum: ["ok", "warn", "blocked"] },
      message: { type: "string" },
      details: { type: "object", additionalProperties: true },
    },
  } as const;

  const eligibilityResultSchema = {
    type: "object",
    required: ["eligible", "checks"],
    properties: {
      eligible: { type: "boolean" },
      checks: { type: "array", items: eligibilityCheckSchema },
      requiredAction: {
        type: "object",
        required: ["type", "message"],
        properties: {
          type: { type: "string", enum: ["stake", "register-agent", "setup-identity"] },
          required: { type: "string" },
          current: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  } as const;

  fastify.get<{ Params: { organizationId: string; principalId: string }; Querystring: { chainId?: string; identityId?: string; chainAgentId?: string } }>(
    "/organizations/:organizationId/agents/:principalId/join-eligibility",
    {
      ...authPolicy("public-read", {
        tags: ["Organizations"],
        summary: "Check agent join eligibility for an organization",
        params: {
          type: "object",
          required: ["organizationId", "principalId"],
          properties: {
            organizationId: { type: "string" },
            principalId: { type: "string" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            chainId: { type: "string" },
            identityId: { type: "string" },
            chainAgentId: { type: "string" },
          },
        },
        response: {
          200: envelopeKey("eligibility", eligibilityResultSchema),
        },
      }),
    },
    async (request) => {
      const { organizationId, principalId } = request.params;
      const { chainId, identityId, chainAgentId } = request.query;
      const result = await checkJoinEligibility(
        {
          organizationId,
          principalId,
          chainId,
          identityId,
          chainAgentId,
          minActiveStake: fastify.config.orgMembershipMinActiveStake,
        },
        fastify.coordinatorStore,
      );
      return ok({ eligibility: result });
    },
  );

  fastify.get<{ Params: { organizationId: string; principalId: string } }>(
    "/organizations/:organizationId/agents/:principalId/exit-eligibility",
    {
      ...authPolicy("public-read", {
        tags: ["Organizations"],
        summary: "Check agent exit eligibility for an organization",
        params: {
          type: "object",
          required: ["organizationId", "principalId"],
          properties: {
            organizationId: { type: "string" },
            principalId: { type: "string" },
          },
        },
        response: {
          200: envelopeKey("eligibility", eligibilityResultSchema),
        },
      }),
    },
    async (request) => {
      const { organizationId, principalId } = request.params;
      const result = await checkExitEligibility({ organizationId, principalId }, fastify.coordinatorStore);
      return ok({ eligibility: result });
    },
  );
};

export default organizationsRoutes;
