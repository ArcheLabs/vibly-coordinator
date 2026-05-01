import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";
import { envelopeKey, listEnvelope } from "../../domain/schemas.js";
import { v4 as uuidv4 } from "uuid";

interface ObservationRecord {
  id: string;
  projectId: string;
  objectiveId?: string;
  observerId: string;
  scope: string[];
  findings: Array<{ title: string; description?: string }>;
  risks: unknown[];
  suggestedActions: Array<{ type: string; title: string; description?: string }>;
  contextReceipt?: unknown;
  createdAt: string;
}

// In-memory store for observations (projection-backed in real usage)
const observations = new Map<string, ObservationRecord>();

const observationsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /observations
  fastify.post<{
    Body: {
      projectId: string;
      objectiveId?: string;
      observerId: string;
      contextReceipt?: Record<string, unknown>;
      scope?: string[];
      findings?: Array<{ title: string; description?: string }>;
      risks?: unknown[];
      suggestedActions?: Array<{ type: string; title: string; description?: string }>;
    };
  }>(
    "/observations",
    {
      schema: {
        tags: ["Observations"],
        summary: "Submit an observation report",
        body: {
          type: "object",
          required: ["projectId", "observerId"],
          properties: {
            projectId: { type: "string" },
            objectiveId: { type: "string" },
            observerId: { type: "string" },
            contextReceipt: { type: "object" },
            scope: { type: "array", items: { type: "string" } },
            findings: { type: "array", items: { type: "object" } },
            risks: { type: "array", items: { type: "object" } },
            suggestedActions: { type: "array", items: { type: "object" } },
          },
        },
        response: { 200: envelopeKey("observation") },
      },
    },
    async (request) => {
      const observation: ObservationRecord = {
        id: `obs_${uuidv4().replace(/-/g, "").slice(0, 16)}`,
        projectId: request.body.projectId,
        objectiveId: request.body.objectiveId,
        observerId: request.body.observerId,
        scope: request.body.scope ?? [],
        findings: request.body.findings ?? [],
        risks: request.body.risks ?? [],
        suggestedActions: request.body.suggestedActions ?? [],
        contextReceipt: request.body.contextReceipt,
        createdAt: new Date().toISOString(),
      };

      observations.set(observation.id, observation);
      await fastify.coordinatorStore.saveProjection("observation", observation.id, observation);

      // Emit event
      const { createEvent } = await import("@concord/foundation");
      const event = createEvent({ type: "ObservationSubmitted", payload: observation });
      await fastify.concord.state.events.append(event);
      fastify.eventBus.publish(event);

      return ok({ observation });
    },
  );

  // GET /projects/:projectId/observations
  fastify.get<{ Params: { projectId: string }; Querystring: { limit?: string; cursor?: string } }>(
    "/projects/:projectId/observations",
    {
      schema: {
        tags: ["Observations"],
        summary: "List observations for a project",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
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
      const allObs = await fastify.coordinatorStore.listProjections<ObservationRecord>("observation");
      const all = allObs.filter((o) => o.projectId === request.params.projectId);

      let startIdx = 0;
      if (cursor) {
        const idx = all.findIndex((o) => o.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = all.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // GET /observations/:observationId
  fastify.get<{ Params: { observationId: string } }>(
    "/observations/:observationId",
    {
      schema: {
        tags: ["Observations"],
        summary: "Get an observation",
        params: { type: "object", required: ["observationId"], properties: { observationId: { type: "string" } } },
        response: { 200: envelopeKey("observation") },
      },
    },
    async (request) => {
      const observation = await fastify.coordinatorStore.getProjection<ObservationRecord>("observation", request.params.observationId);
      if (!observation) throw notFound("Observation", request.params.observationId);
      return ok({ observation });
    },
  );
};

export default observationsRoutes;
