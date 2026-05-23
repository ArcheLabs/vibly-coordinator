/**
 * Public Library API routes — read-only, no authentication required.
 *
 * Path prefix: /api/public/*
 *
 * All responses use the standard Coordinator envelope:
 *   { ok, data, page?, meta }
 */

import type { FastifyPluginAsync } from "fastify";
import { ok, okList, makeRequestId } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";
import { envelopeKey, listEnvelope } from "../../domain/schemas.js";
import { authPolicy } from "../../plugins/authPolicy.js";
import { PublicLibraryRepository } from "../../contexts/library/repository.js";
import {
  PUBLIC_ARTIFACT_SCHEMA,
  PUBLIC_ORG_SCHEMA,
  PUBLIC_PROJECT_SCHEMA,
  PUBLIC_AGENT_SCHEMA,
} from "../../contexts/library/schemas.js";
import type { ArtifactListFilter, PublicArtifact } from "../../contexts/library/types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(raw: number | undefined): number {
  const n = raw ?? DEFAULT_LIMIT;
  return Math.max(1, Math.min(n, MAX_LIMIT));
}

/** Sort an array of artifacts in-place and return it. */
function sortArtifacts(items: PublicArtifact[], sort?: string): PublicArtifact[] {
  switch (sort) {
    case "latest":
      return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    case "hot":
      return items.sort((a, b) => b.hotScore - a.hotScore);
    case "reviewed":
      return items.sort((a, b) => b.reviewCount - a.reviewCount);
    case "order":
      return items.sort((a, b) => a.order - b.order || b.updatedAt.localeCompare(a.updatedAt));
    case "comprehensive":
    default:
      return items.sort((a, b) => (b.hotScore + b.reviewCount * 5) - (a.hotScore + a.reviewCount * 5));
  }
}

const publicLibraryRoutes: FastifyPluginAsync = async (fastify) => {
  const repo = () => new PublicLibraryRepository(fastify.coordinatorStore);

  // ─── Artifacts ─────────────────────────────────────────────────────────────

  fastify.get<{
    Querystring: {
      q?: string;
      sort?: "comprehensive" | "latest" | "hot" | "reviewed" | "order";
      type?: "report" | "spec" | "note" | "template";
      status?: "published" | "verified" | "updated";
      org?: string;
      project?: string;
      agent?: string;
      limit?: number;
      offset?: number;
      locale?: string;
    };
  }>(
    "/api/public/artifacts",
    {
      ...authPolicy("public-read", {
        tags: ["Public Library"],
        summary: "List published artifacts",
        querystring: {
          type: "object",
          properties: {
            q: { type: "string" },
            sort: { type: "string", enum: ["comprehensive", "latest", "hot", "reviewed", "order"] },
            type: { type: "string", enum: ["report", "spec", "note", "template"] },
            status: { type: "string", enum: ["published", "verified", "updated"] },
            org: { type: "string" },
            project: { type: "string" },
            agent: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
            offset: { type: "integer", minimum: 0, default: 0 },
            locale: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["ok", "data", "page"],
            properties: {
              ok: { type: "boolean", const: true },
              data: {
                type: "object",
                required: ["items", "total"],
                properties: {
                  items: { type: "array", items: PUBLIC_ARTIFACT_SCHEMA },
                  total: { type: "integer" },
                },
              },
              page: {
                type: "object",
                required: ["limit", "nextCursor"],
                properties: {
                  limit: { type: "integer" },
                  nextCursor: { type: ["string", "null"] },
                },
              },
              meta: { type: "object", properties: { requestId: { type: "string" } } },
            },
          },
        },
      }),
    },
    async (req) => {
      const { q, sort, type, status, org, project, agent, locale, offset } = req.query;
      const limit = clampLimit(req.query.limit);
      const skip = offset ?? 0;

      const filter: ArtifactListFilter = { q, sort, type, status, org, project, agent, locale };
      const all = sortArtifacts(await repo().listArtifacts(filter), sort);
      const total = all.length;
      const page = all.slice(skip, skip + limit);
      const nextCursor = skip + limit < total ? String(skip + limit) : null;

      return {
        ok: true as const,
        data: { items: page, total },
        page: { limit, nextCursor },
        meta: { requestId: makeRequestId() },
      };
    },
  );

  fastify.get<{ Querystring: { limit?: number; locale?: string } }>(
    "/api/public/artifacts/popular",
    {
      ...authPolicy("public-read", {
        tags: ["Public Library"],
        summary: "List popular artifacts by hot score",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: 10 },
            locale: { type: "string" },
          },
        },
        response: {
          200: envelopeKey("items", { type: "array", items: PUBLIC_ARTIFACT_SCHEMA }),
        },
      }),
    },
    async (req) => {
      const limit = clampLimit(req.query.limit ?? 10);
      let items = await repo().listPopularArtifacts(limit);
      if (req.query.locale) {
        items = items.filter((a) => !a.locale || a.locale === req.query.locale);
      }
      return ok({ items });
    },
  );

  fastify.get<{ Params: { slug: string } }>(
    "/api/public/artifacts/:slug",
    {
      ...authPolicy("public-read", {
        tags: ["Public Library"],
        summary: "Get a published artifact by slug",
        params: {
          type: "object",
          required: ["slug"],
          properties: { slug: { type: "string" } },
        },
        response: {
          200: envelopeKey("artifact", PUBLIC_ARTIFACT_SCHEMA),
        },
      }),
    },
    async (req) => {
      const artifact = await repo().getArtifactBySlug(req.params.slug);
      if (!artifact) throw notFound("PublicArtifact", req.params.slug);
      return ok({ artifact });
    },
  );

  // ─── Organizations ─────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { q?: string; limit?: number; offset?: number } }>(
    "/api/public/orgs",
    {
      ...authPolicy("public-read", {
        tags: ["Public Library"],
        summary: "List public organizations",
        querystring: {
          type: "object",
          properties: {
            q: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: listEnvelope(PUBLIC_ORG_SCHEMA),
        },
      }),
    },
    async (req) => {
      const limit = clampLimit(req.query.limit);
      const skip = req.query.offset ?? 0;
      let orgs = await repo().listOrganizations();
      if (req.query.q) {
        const q = req.query.q.toLowerCase();
        orgs = orgs.filter(
          (o) => o.name.toLowerCase().includes(q) || o.description.toLowerCase().includes(q),
        );
      }
      const page = orgs.slice(skip, skip + limit);
      return okList(page, { limit, nextCursor: skip + limit < orgs.length ? String(skip + limit) : null });
    },
  );

  fastify.get<{ Params: { slug: string } }>(
    "/api/public/orgs/:slug",
    {
      ...authPolicy("public-read", {
        tags: ["Public Library"],
        summary: "Get a public organization by slug",
        params: {
          type: "object",
          required: ["slug"],
          properties: { slug: { type: "string" } },
        },
        response: {
          200: envelopeKey("org", PUBLIC_ORG_SCHEMA),
        },
      }),
    },
    async (req) => {
      const org = await repo().getOrganizationBySlug(req.params.slug);
      if (!org) throw notFound("PublicOrganization", req.params.slug);
      return ok({ org });
    },
  );

  // ─── Projects ──────────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { q?: string; limit?: number; offset?: number } }>(
    "/api/public/projects",
    {
      ...authPolicy("public-read", {
        tags: ["Public Library"],
        summary: "List public projects",
        querystring: {
          type: "object",
          properties: {
            q: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: listEnvelope(PUBLIC_PROJECT_SCHEMA),
        },
      }),
    },
    async (req) => {
      const limit = clampLimit(req.query.limit);
      const skip = req.query.offset ?? 0;
      const projects = await repo().listProjects(req.query.q);
      const page = projects.slice(skip, skip + limit);
      return okList(page, { limit, nextCursor: skip + limit < projects.length ? String(skip + limit) : null });
    },
  );

  // ─── Agents ────────────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { q?: string; limit?: number; offset?: number } }>(
    "/api/public/agents",
    {
      ...authPolicy("public-read", {
        tags: ["Public Library"],
        summary: "List public agents",
        querystring: {
          type: "object",
          properties: {
            q: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: {
          200: listEnvelope(PUBLIC_AGENT_SCHEMA),
        },
      }),
    },
    async (req) => {
      const limit = clampLimit(req.query.limit);
      const skip = req.query.offset ?? 0;
      const agents = await repo().listAgents(req.query.q);
      const page = agents.slice(skip, skip + limit);
      return okList(page, { limit, nextCursor: skip + limit < agents.length ? String(skip + limit) : null });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/api/public/agents/:id",
    {
      ...authPolicy("public-read", {
        tags: ["Public Library"],
        summary: "Get a public agent by ID",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: envelopeKey("agent", PUBLIC_AGENT_SCHEMA),
        },
      }),
    },
    async (req) => {
      const agent = await repo().getAgentById(req.params.id);
      if (!agent) throw notFound("PublicAgent", req.params.id);
      return ok({ agent });
    },
  );
};

export default publicLibraryRoutes;
