import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { envelopeKey, listEnvelope } from "../../../domain/schemas.js";

const projectsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /projects
  fastify.post<{
    Body: {
      slug: string;
      name: string;
      description?: string;
      sponsorPrincipalId: string;
      metadata?: Record<string, unknown>;
    };
  }>(
    "/projects",
    {
      schema: {
        tags: ["Projects"],
        summary: "Create a new project",
        body: {
          type: "object",
          required: ["slug", "name", "sponsorPrincipalId"],
          properties: {
            slug: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
            description: { type: "string" },
            sponsorPrincipalId: { type: "string" },
            metadata: { type: "object" },
          },
        },
        response: { 200: envelopeKey("project") },
      },
    },
    async (request) => {
      const project = await fastify.concord.projects.createProject({
        slug: request.body.slug,
        name: request.body.name,
        description: request.body.description,
        sponsorPrincipalId: request.body.sponsorPrincipalId as never,
        boundary: {
          projectId: undefined,
          createdBy: request.body.sponsorPrincipalId as never,
        },
        metadata: request.body.metadata,
      });
      return ok({ project });
    },
  );

  // GET /projects
  fastify.get<{ Querystring: { status?: string; limit?: string; cursor?: string } }>(
    "/projects",
    {
      schema: {
        tags: ["Projects"],
        summary: "List projects",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: { 200: listEnvelope() },
      },
    },
    async (request) => {
      const { status, limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);
      let projects = await fastify.concord.projects.listProjects();
      if (status) projects = projects.filter((p) => p.status === status);

      let startIdx = 0;
      if (cursor) {
        const idx = projects.findIndex((p) => p.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = projects.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // GET /projects/:projectId
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId",
    {
      schema: {
        tags: ["Projects"],
        summary: "Get a project",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        response: { 200: envelopeKey("project") },
      },
    },
    async (request) => {
      const project = await fastify.concord.projects.getProject(request.params.projectId as never);
      if (!project) throw notFound("Project", request.params.projectId);
      return ok({ project });
    },
  );

  // POST /projects/:projectId/activate
  fastify.post<{
    Params: { projectId: string };
    Body: { actorId: string; reason?: string };
  }>(
    "/projects/:projectId/activate",
    {
      schema: {
        tags: ["Projects"],
        summary: "Activate a project",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        body: {
          type: "object",
          required: ["actorId"],
          properties: { actorId: { type: "string" }, reason: { type: "string" } },
        },
        response: { 200: envelopeKey("project") },
      },
    },
    async (request) => {
      const project = await fastify.concord.projects.activateProject({
        projectId: request.params.projectId as never,
        actorId: request.body.actorId as never,
        reason: request.body.reason,
      });
      return ok({ project });
    },
  );

  // POST /projects/:projectId/pause
  fastify.post<{
    Params: { projectId: string };
    Body: { actorId: string; reason: string };
  }>(
    "/projects/:projectId/pause",
    {
      schema: {
        tags: ["Projects"],
        summary: "Pause a project",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        body: {
          type: "object",
          required: ["actorId", "reason"],
          properties: { actorId: { type: "string" }, reason: { type: "string" } },
        },
        response: { 200: envelopeKey("project") },
      },
    },
    async (request) => {
      const project = await fastify.concord.projects.pauseProject({
        projectId: request.params.projectId as never,
        actorId: request.body.actorId as never,
        reason: request.body.reason,
      });
      return ok({ project });
    },
  );

  // POST /projects/:projectId/archive
  fastify.post<{
    Params: { projectId: string };
    Body: { actorId: string; reason: string };
  }>(
    "/projects/:projectId/archive",
    {
      schema: {
        tags: ["Projects"],
        summary: "Archive a project",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        body: {
          type: "object",
          required: ["actorId", "reason"],
          properties: { actorId: { type: "string" }, reason: { type: "string" } },
        },
        response: { 200: envelopeKey("project") },
      },
    },
    async (request) => {
      const project = await fastify.concord.projects.archiveProject({
        projectId: request.params.projectId as never,
        actorId: request.body.actorId as never,
        reason: request.body.reason,
      });
      return ok({ project });
    },
  );
};

export default projectsRoutes;
