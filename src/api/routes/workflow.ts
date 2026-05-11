/**
 * Workflow read-model routes — tasks, submissions, artifacts, review rounds.
 * All writes go through POST /action-intents.
 */

import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";
import { envelopeKey, envelopeKeyArray } from "../../domain/schemas.js";
import { WorkRepository } from "../../contexts/work/repository.js";
import { ArtifactRepository } from "../../contexts/artifact/repository.js";
import { ReviewRepository } from "../../contexts/evaluation/repository.js";

const ITEM_SCHEMA = { type: "object" as const, additionalProperties: true };

const workflowRoutes: FastifyPluginAsync = async (fastify) => {
  const workRepo = () => new WorkRepository(fastify.coordinatorStore);
  const artifactRepo = () => new ArtifactRepository(fastify.coordinatorStore);
  const reviewRepo = () => new ReviewRepository(fastify.coordinatorStore);

  // ─── Tasks ─────────────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    "/tasks/:id",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Get task by ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("task") },
      },
    },
    async (req) => {
      const task = await workRepo().getTask(req.params.id);
      if (!task) throw notFound("Task", req.params.id);
      return ok({ task });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; assigneeId?: string; status?: string; limit?: number } }>(
    "/tasks",
    {
      schema: {
        tags: ["Tasks"],
        summary: "List tasks",
        querystring: {
          type: "object",
          properties: {
            organizationId: { type: "string" },
            assigneeId: { type: "string" },
            status: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      },
    },
    async (req) => {
      let items = await workRepo().listTasks(req.query.organizationId);
      if (req.query.assigneeId) items = items.filter((t) => t.assigneeId === req.query.assigneeId);
      if (req.query.status) items = items.filter((t) => t.status === req.query.status);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  // ─── Submissions ───────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    "/submissions/:id",
    {
      schema: {
        tags: ["Submissions"],
        summary: "Get task submission by ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("submission") },
      },
    },
    async (req) => {
      const submission = await workRepo().getSubmission(req.params.id);
      if (!submission) throw notFound("TaskSubmission", req.params.id);
      return ok({ submission });
    },
  );

  fastify.get<{ Querystring: { taskId?: string; limit?: number } }>(
    "/submissions",
    {
      schema: {
        tags: ["Submissions"],
        summary: "List task submissions",
        querystring: {
          type: "object",
          properties: { taskId: { type: "string" }, limit: { type: "integer", default: 50 } },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      },
    },
    async (req) => {
      const items = await workRepo().listSubmissions(req.query.taskId);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  // ─── Artifacts ─────────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    "/artifacts/:id",
    {
      schema: {
        tags: ["Artifacts"],
        summary: "Get artifact by ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("artifact") },
      },
    },
    async (req) => {
      const artifact = await artifactRepo().get(req.params.id);
      if (!artifact) throw notFound("Artifact", req.params.id);
      return ok({ artifact });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; taskId?: string; limit?: number } }>(
    "/artifacts",
    {
      schema: {
        tags: ["Artifacts"],
        summary: "List artifacts",
        querystring: {
          type: "object",
          properties: {
            organizationId: { type: "string" },
            taskId: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      },
    },
    async (req) => {
      let items = await artifactRepo().list(req.query.organizationId);
      if (req.query.taskId) items = items.filter((a) => a.taskId === req.query.taskId);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  // ─── Review Rounds ─────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    "/review-rounds/:id",
    {
      schema: {
        tags: ["ReviewRounds"],
        summary: "Get review round by ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("reviewRound") },
      },
    },
    async (req) => {
      const reviewRound = await reviewRepo().get(req.params.id);
      if (!reviewRound) throw notFound("ReviewRound", req.params.id);
      return ok({ reviewRound });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; taskId?: string; status?: string; limit?: number } }>(
    "/review-rounds",
    {
      schema: {
        tags: ["ReviewRounds"],
        summary: "List review rounds",
        querystring: {
          type: "object",
          properties: {
            organizationId: { type: "string" },
            taskId: { type: "string" },
            status: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      },
    },
    async (req) => {
      let items = await reviewRepo().list(req.query.organizationId);
      if (req.query.taskId) items = items.filter((r) => r.taskId === req.query.taskId);
      if (req.query.status) items = items.filter((r) => r.status === req.query.status);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );
};

export default workflowRoutes;
