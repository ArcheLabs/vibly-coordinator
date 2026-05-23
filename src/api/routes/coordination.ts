/**
 * Coordination read-model routes — observations, discussions, proposals,
 * voting rounds.  All writes go through POST /action-intents.
 */

import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";
import { envelopeKey, envelopeKeyArray } from "../../domain/schemas.js";
import { CoordinationRepository } from "../../contexts/coordination/repository.js";
import { authPolicy } from "../../plugins/authPolicy.js";

const ITEM_SCHEMA = { type: "object" as const, additionalProperties: true };

const coordinationRoutes: FastifyPluginAsync = async (fastify) => {
  const repo = () => new CoordinationRepository(fastify.coordinatorStore);

  // ─── Observation Tasks ───────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    "/observation-tasks/:id",
    {
      ...authPolicy("public-read", {
        tags: ["ObservationTasks"],
        summary: "Get observation task by ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("observationTask") },
      }),
    },
    async (req) => {
      const task = await repo().getObservationTask(req.params.id);
      if (!task) throw notFound("ObservationTask", req.params.id);
      return ok({ observationTask: task });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; assigneeId?: string; limit?: number } }>(
    "/observation-tasks",
    {
      ...authPolicy("public-read", {
        tags: ["ObservationTasks"],
        summary: "List observation tasks",
        querystring: {
          type: "object",
          properties: {
            organizationId: { type: "string" },
            assigneeId: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      let items = await repo().listObservationTasks(req.query.organizationId);
      if (req.query.assigneeId) items = items.filter((t) => t.assigneeId === req.query.assigneeId);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; observationTaskId?: string; submittedBy?: string; limit?: number } }>(
    "/observations",
    {
      ...authPolicy("public-read", {
        tags: ["Observations"],
        summary: "List observations",
        querystring: {
          type: "object",
          properties: {
            organizationId: { type: "string" },
            observationTaskId: { type: "string" },
            submittedBy: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      let items = await repo().listObservations(req.query.organizationId);
      if (req.query.observationTaskId) items = items.filter((o) => o.observationTaskId === req.query.observationTaskId);
      if (req.query.submittedBy) items = items.filter((o) => o.submittedBy === req.query.submittedBy);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  // ─── Discussions ─────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    "/discussions/:id",
    {
      ...authPolicy("public-read", {
        tags: ["Discussions"],
        summary: "Get discussion by ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("discussion") },
      }),
    },
    async (req) => {
      const discussion = await repo().getDiscussion(req.params.id);
      if (!discussion) throw notFound("DiscussionThread", req.params.id);
      return ok({ discussion });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; limit?: number } }>(
    "/discussions",
    {
      ...authPolicy("public-read", {
        tags: ["Discussions"],
        summary: "List discussions",
        querystring: {
          type: "object",
          properties: { organizationId: { type: "string" }, limit: { type: "integer", default: 50 } },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      const items = await repo().listDiscussions(req.query.organizationId);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  // ─── Proposals ───────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    "/proposals/:id",
    {
      ...authPolicy("public-read", {
        tags: ["Proposals"],
        summary: "Get proposal by ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("proposal") },
      }),
    },
    async (req) => {
      const proposal = await repo().getProposal(req.params.id);
      if (!proposal) throw notFound("Proposal", req.params.id);
      return ok({ proposal });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; status?: string; limit?: number } }>(
    "/proposals",
    {
      ...authPolicy("public-read", {
        tags: ["Proposals"],
        summary: "List proposals",
        querystring: {
          type: "object",
          properties: {
            organizationId: { type: "string" },
            status: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      let items = await repo().listProposals(req.query.organizationId);
      if (req.query.status) items = items.filter((p) => p.status === req.query.status);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  // ─── Voting Rounds ───────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    "/voting-rounds/:id",
    {
      ...authPolicy("public-read", {
        tags: ["VotingRounds"],
        summary: "Get voting round by ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("votingRound") },
      }),
    },
    async (req) => {
      const votingRound = await repo().getVotingRound(req.params.id);
      if (!votingRound) throw notFound("VotingRound", req.params.id);
      return ok({ votingRound });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; proposalId?: string; limit?: number } }>(
    "/voting-rounds",
    {
      ...authPolicy("public-read", {
        tags: ["VotingRounds"],
        summary: "List voting rounds",
        querystring: {
          type: "object",
          properties: {
            organizationId: { type: "string" },
            proposalId: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      let items = await repo().listVotingRounds(req.query.organizationId);
      if (req.query.proposalId) items = items.filter((v) => v.proposalId === req.query.proposalId);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  // ─── Mechanisms ──────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    "/mechanisms/:id",
    {
      ...authPolicy("public-read", {
        tags: ["Mechanisms"],
        summary: "Get coordination mechanism by ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("mechanism") },
      }),
    },
    async (req) => {
      const { MechanismRepository } = await import("../../contexts/mechanism/repository.js");
      const mechRepo = new MechanismRepository(fastify.coordinatorStore);
      const mechanism = await mechRepo.get(req.params.id);
      if (!mechanism) throw notFound("CoordinationMechanism", req.params.id);
      return ok({ mechanism });
    },
  );

  fastify.get<{ Querystring: { organizationId?: string; limit?: number } }>(
    "/mechanisms",
    {
      ...authPolicy("public-read", {
        tags: ["Mechanisms"],
        summary: "List coordination mechanisms",
        querystring: {
          type: "object",
          properties: {
            organizationId: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      const { MechanismRepository } = await import("../../contexts/mechanism/repository.js");
      const mechRepo = new MechanismRepository(fastify.coordinatorStore);
      const items = await mechRepo.list(req.query.organizationId);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );
  // ─── Coordination Rounds ────────────────────────────────────────────────

  fastify.get<{ Querystring: { status?: string; limit?: number } }>(
    "/coordination/rounds",
    {
      ...authPolicy("public-read", {
        tags: ["CoordinationRounds"],
        summary: "List coordination rounds",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string" },
            limit: { type: "number" },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      const { RoundRepository } = await import("../../contexts/round/repository.js");
      const roundRepo = new RoundRepository(fastify.coordinatorStore);
      let items = await roundRepo.list();
      if (req.query.status) items = items.filter((r) => r.status === req.query.status);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  fastify.get(
    "/coordination/rounds/current",
    {
      ...authPolicy("public-read", {
        tags: ["CoordinationRounds"],
        summary: "Get the currently active coordination round",
        response: { 200: envelopeKey("round") },
      }),
    },
    async () => {
      const { RoundRepository } = await import("../../contexts/round/repository.js");
      const roundRepo = new RoundRepository(fastify.coordinatorStore);
      const round = await roundRepo.findActive();
      if (!round) throw notFound("CoordinationRound", "active");
      return ok({ round });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/coordination/rounds/:id",
    {
      ...authPolicy("public-read", {
        tags: ["CoordinationRounds"],
        summary: "Get a coordination round by ID",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: { 200: envelopeKey("round") },
      }),
    },
    async (req) => {
      const { RoundRepository } = await import("../../contexts/round/repository.js");
      const roundRepo = new RoundRepository(fastify.coordinatorStore);
      const round = await roundRepo.get(req.params.id);
      if (!round) throw notFound("CoordinationRound", req.params.id);
      return ok({ round });
    },
  );
};

export default coordinationRoutes;
