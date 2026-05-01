import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { envelopeKey, listEnvelope } from "../../../domain/schemas.js";

const objectivesRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /projects/:projectId/objectives
  fastify.post<{
    Params: { projectId: string };
    Body: {
      title: string;
      description: string;
      kind?: string;
      createdBy: string;
      parentObjectiveId?: string;
      successCriteria?: Array<{ description: string; verificationMethod?: string }>;
      forbiddenOutcomes?: string[];
      priority?: number;
    };
  }>(
    "/projects/:projectId/objectives",
    {
      schema: {
        tags: ["Objectives"],
        summary: "Create an objective",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        body: {
          type: "object",
          required: ["title", "description", "createdBy"],
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            kind: { type: "string" },
            createdBy: { type: "string" },
            parentObjectiveId: { type: "string" },
            successCriteria: { type: "array" },
            forbiddenOutcomes: { type: "array", items: { type: "string" } },
            priority: { type: "number" },
          },
        },
        response: { 200: envelopeKey("objective") },
      },
    },
    async (request) => {
      const objective = await fastify.concord.objectives.createObjective({
        projectId: request.params.projectId as never,
        title: request.body.title,
        description: request.body.description,
        kind: (request.body.kind ?? "milestone") as never,
        createdBy: request.body.createdBy as never,
        parentObjectiveId: request.body.parentObjectiveId as never,
        successCriteria: (request.body.successCriteria ?? []) as never,
        forbiddenOutcomes: request.body.forbiddenOutcomes ?? [],
        priority: request.body.priority,
      });
      return ok({ objective });
    },
  );

  // GET /projects/:projectId/objectives
  fastify.get<{
    Params: { projectId: string };
    Querystring: { status?: string; kind?: string; limit?: string; cursor?: string };
  }>(
    "/projects/:projectId/objectives",
    {
      schema: {
        tags: ["Objectives"],
        summary: "List objectives for a project",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        querystring: {
          type: "object",
          properties: {
            status: { type: "string" },
            kind: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: { 200: listEnvelope() },
      },
    },
    async (request) => {
      const { status, kind, limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);
      let objectives = await fastify.concord.objectives.listObjectives(request.params.projectId as never);
      if (status) objectives = objectives.filter((o) => o.status === status);
      if (kind) objectives = objectives.filter((o) => o.kind === kind);

      let startIdx = 0;
      if (cursor) {
        const idx = objectives.findIndex((o) => o.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = objectives.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // GET /objectives/:objectiveId
  fastify.get<{ Params: { objectiveId: string } }>(
    "/objectives/:objectiveId",
    {
      schema: {
        tags: ["Objectives"],
        summary: "Get an objective",
        params: { type: "object", required: ["objectiveId"], properties: { objectiveId: { type: "string" } } },
        response: { 200: envelopeKey("objective") },
      },
    },
    async (request) => {
      const objective = await fastify.concord.objectives.getObjective(request.params.objectiveId as never);
      if (!objective) throw notFound("Objective", request.params.objectiveId);
      return ok({ objective });
    },
  );

  // POST /objectives/:objectiveId/activate
  fastify.post<{ Params: { objectiveId: string }; Body: { actorId: string } }>(
    "/objectives/:objectiveId/activate",
    {
      schema: {
        tags: ["Objectives"],
        summary: "Activate an objective",
        params: { type: "object", required: ["objectiveId"], properties: { objectiveId: { type: "string" } } },
        body: {
          type: "object",
          required: ["actorId"],
          properties: { actorId: { type: "string" } },
        },
        response: { 200: envelopeKey("objective") },
      },
    },
    async (request) => {
      const objective = await fastify.concord.objectives.activateObjective({
        objectiveId: request.params.objectiveId as never,
        actorId: request.body.actorId as never,
      });
      return ok({ objective });
    },
  );

  // POST /projects/:projectId/objectives/:objectiveId/set-primary
  fastify.post<{
    Params: { projectId: string; objectiveId: string };
    Body: { actorId: string };
  }>(
    "/projects/:projectId/objectives/:objectiveId/set-primary",
    {
      schema: {
        tags: ["Objectives"],
        summary: "Set primary objective for a project",
        params: {
          type: "object",
          required: ["projectId", "objectiveId"],
          properties: { projectId: { type: "string" }, objectiveId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["actorId"],
          properties: { actorId: { type: "string" } },
        },
        response: { 200: envelopeKey("project") },
      },
    },
    async (request) => {
      const project = await fastify.concord.objectives.setPrimaryObjective({
        projectId: request.params.projectId as never,
        objectiveId: request.params.objectiveId as never,
        actorId: request.body.actorId as never,
      });
      return ok({ project });
    },
  );

  // POST /objectives/:objectiveId/close
  fastify.post<{
    Params: { objectiveId: string };
    Body: { actorId: string; status: string; reason: string };
  }>(
    "/objectives/:objectiveId/close",
    {
      schema: {
        tags: ["Objectives"],
        summary: "Close an objective",
        params: { type: "object", required: ["objectiveId"], properties: { objectiveId: { type: "string" } } },
        body: {
          type: "object",
          required: ["actorId", "status", "reason"],
          properties: {
            actorId: { type: "string" },
            status: { type: "string" },
            reason: { type: "string" },
          },
        },
        response: { 200: envelopeKey("objective") },
      },
    },
    async (request) => {
      const objective = await fastify.concord.objectives.closeObjective({
        objectiveId: request.params.objectiveId as never,
        actorId: request.body.actorId as never,
        status: request.body.status as never,
        reason: request.body.reason,
      });
      return ok({ objective });
    },
  );
};

export default objectivesRoutes;
