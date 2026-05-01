import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { envelopeKey } from "../../../domain/schemas.js";
import { v4 as uuidv4 } from "uuid";

const boundaryRoutes: FastifyPluginAsync = async (fastify) => {
  // PUT /projects/:projectId/boundary — create or replace boundary
  fastify.put<{
    Params: { projectId: string };
    Body: {
      createdBy: string;
      description?: string;
      prohibitedActions?: Array<{ actionType: string; effect: string; reason: string }>;
      riskRules?: Array<{ actionType: string; riskLevel: string; reason: string }>;
      escalationRules?: Array<{ actionType: string; requiredFlow: string; reason: string }>;
      permissionRules?: unknown[];
      defaultRiskLevel?: string;
    };
  }>(
    "/projects/:projectId/boundary",
    {
      schema: {
        tags: ["Boundary"],
        summary: "Create or replace project boundary",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        body: {
          type: "object",
          required: ["createdBy"],
          properties: {
            createdBy: { type: "string" },
            description: { type: "string" },
            prohibitedActions: { type: "array" },
            riskRules: { type: "array" },
            escalationRules: { type: "array" },
            permissionRules: { type: "array" },
            defaultRiskLevel: { type: "string" },
          },
        },
        response: { 200: envelopeKey("boundary") },
      },
    },
    async (request) => {
      const prohibitedActions = (request.body.prohibitedActions ?? []).map((r) => ({
        id: uuidv4(),
        actionType: r.actionType,
        effect: r.effect as "allow" | "deny",
        reason: r.reason,
      }));
      const riskRules = (request.body.riskRules ?? []).map((r) => ({
        id: uuidv4(),
        actionType: r.actionType,
        riskLevel: r.riskLevel as never,
        reason: r.reason,
      }));
      const escalationRules = (request.body.escalationRules ?? []).map((r) => ({
        id: uuidv4(),
        actionType: r.actionType,
        requiredFlow: r.requiredFlow as never,
        reason: r.reason,
      }));

      const boundary = await fastify.concord.boundaries.createBoundary({
        projectId: request.params.projectId as never,
        createdBy: request.body.createdBy as never,
        description: request.body.description,
        prohibitedActions,
        riskRules,
        escalationRules,
        permissionRules: (request.body.permissionRules ?? []) as never,
        defaultRiskLevel: (request.body.defaultRiskLevel ?? "low") as never,
      });

      // Auto-activate the boundary
      const activated = await fastify.concord.boundaries.activateBoundary({
        boundaryId: boundary.id,
        actorId: request.body.createdBy as never,
      });

      return ok({ boundary: activated });
    },
  );

  // GET /projects/:projectId/boundary
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/boundary",
    {
      schema: {
        tags: ["Boundary"],
        summary: "Get active boundary for a project",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        response: { 200: envelopeKey("boundary") },
      },
    },
    async (request) => {
      const boundary = await fastify.concord.boundaries.getActiveBoundary(request.params.projectId as never);
      if (!boundary) throw notFound("Boundary", request.params.projectId);
      return ok({ boundary });
    },
  );

  // GET /projects/:projectId/boundary/:boundaryId
  fastify.get<{ Params: { projectId: string; boundaryId: string } }>(
    "/projects/:projectId/boundary/:boundaryId",
    {
      schema: {
        tags: ["Boundary"],
        summary: "Get a specific boundary",
        params: {
          type: "object",
          required: ["projectId", "boundaryId"],
          properties: { projectId: { type: "string" }, boundaryId: { type: "string" } },
        },
        response: { 200: envelopeKey("boundary") },
      },
    },
    async (request) => {
      const boundary = await fastify.concord.boundaries.getBoundary(request.params.boundaryId as never);
      if (!boundary) throw notFound("Boundary", request.params.boundaryId);
      return ok({ boundary });
    },
  );

  // POST /projects/:projectId/boundary/evaluate
  fastify.post<{
    Params: { projectId: string };
    Body: { actionType: string; actor?: string; roles?: string[]; metadata?: Record<string, unknown> };
  }>(
    "/projects/:projectId/boundary/evaluate",
    {
      schema: {
        tags: ["Boundary"],
        summary: "Evaluate an action against the boundary",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        body: {
          type: "object",
          required: ["actionType"],
          properties: {
            actionType: { type: "string" },
            actor: { type: "string" },
            roles: { type: "array", items: { type: "string" } },
            metadata: { type: "object" },
          },
        },
        response: { 200: envelopeKey("evaluation") },
      },
    },
    async (request) => {
      const evaluation = await fastify.concord.boundaries.evaluateAction({
        projectId: request.params.projectId as never,
        actionType: request.body.actionType,
        actor: request.body.actor as never,
        roles: (request.body.roles ?? []) as never,
        metadata: request.body.metadata,
      });
      return ok({ evaluation });
    },
  );

  // POST /projects/:projectId/boundary/revise
  fastify.post<{
    Params: { projectId: string };
    Body: {
      actorId: string;
      reason: string;
      decisionRecordId?: string;
      description?: string;
      prohibitedActions?: Array<{ actionType: string; effect: string; reason: string }>;
      riskRules?: Array<{ actionType: string; riskLevel: string; reason: string }>;
    };
  }>(
    "/projects/:projectId/boundary/revise",
    {
      schema: {
        tags: ["Boundary"],
        summary: "Revise project boundary",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        body: {
          type: "object",
          required: ["actorId", "reason"],
          properties: {
            actorId: { type: "string" },
            reason: { type: "string" },
            decisionRecordId: { type: "string" },
            description: { type: "string" },
            prohibitedActions: { type: "array" },
            riskRules: { type: "array" },
          },
        },
        response: { 200: envelopeKey("boundary") },
      },
    },
    async (request) => {
      const activeBoundary = await fastify.concord.boundaries.getActiveBoundary(request.params.projectId as never);
      if (!activeBoundary) throw notFound("Boundary", request.params.projectId);

      const prohibitedActions = (request.body.prohibitedActions ?? []).map((r) => ({
        id: uuidv4(),
        actionType: r.actionType,
        effect: r.effect as "allow" | "deny",
        reason: r.reason,
      }));
      const riskRules = (request.body.riskRules ?? []).map((r) => ({
        id: uuidv4(),
        actionType: r.actionType,
        riskLevel: r.riskLevel as never,
        reason: r.reason,
      }));

      const revised = await fastify.concord.boundaries.reviseBoundary({
        projectId: request.params.projectId as never,
        previousBoundaryId: activeBoundary.id,
        actorId: request.body.actorId as never,
        reason: request.body.reason,
        decisionRecordId: request.body.decisionRecordId as never,
        nextBoundary: {
          description: request.body.description,
          prohibitedActions,
          riskRules,
          escalationRules: activeBoundary.escalationRules,
          permissionRules: activeBoundary.permissionRules,
          defaultRiskLevel: activeBoundary.defaultRiskLevel,
        },
      });
      return ok({ boundary: revised });
    },
  );
};

export default boundaryRoutes;
