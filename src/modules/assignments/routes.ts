import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";
import { envelope, envelopeKey, errorEnvelope, listEnvelope } from "../../domain/schemas.js";
import { v4 as uuidv4 } from "uuid";

interface Assignment {
  id: string;
  projectId?: string;
  role: string;
  actorId: string;
  scope?: { objectiveId?: string };
  leaseId?: string;
  reason?: string;
  status: "active" | "expired" | "released";
  createdAt: string;
}

const assignmentsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /assignments
  fastify.post<{
    Body: {
      projectId?: string;
      role: string;
      actorId: string;
      scope?: { objectiveId?: string };
      leaseSeconds?: number;
      reason?: string;
    };
  }>(
    "/assignments",
    {
      schema: {
        tags: ["Assignments"],
        summary: "Create an assignment",
        body: {
          type: "object",
          required: ["role", "actorId"],
          properties: {
            projectId: { type: "string" },
            role: { type: "string" },
            actorId: { type: "string" },
            scope: { type: "object", properties: { objectiveId: { type: "string" } } },
            leaseSeconds: { type: "number" },
            reason: { type: "string" },
          },
        },
        response: { 200: envelopeKey("assignment") },
      },
    },
    async (request) => {
      const now = new Date().toISOString();
      const assignment: Assignment = {
        id: `assign_${uuidv4().replace(/-/g, "").slice(0, 16)}`,
        projectId: request.body.projectId,
        role: request.body.role,
        actorId: request.body.actorId,
        scope: request.body.scope,
        reason: request.body.reason,
        status: "active",
        createdAt: now,
      };

      if (request.body.leaseSeconds) {
        const lease = await fastify.coordinatorStore.createLease({
          kind: `role:${request.body.role}`,
          resourceId: `${request.body.projectId ?? "global"}:${request.body.scope?.objectiveId ?? "all"}`,
          holderId: request.body.actorId,
          ttlMs: request.body.leaseSeconds * 1000,
        });
        assignment.leaseId = lease.id;
      }

      await fastify.coordinatorStore.saveProjection("assignment", assignment.id, assignment);

      const { createEvent } = await import("@concord/foundation");
      const evt = createEvent({ type: "RoleAssigned", payload: assignment });
      await fastify.concord.state.events.append(evt);
      fastify.eventBus.publish(evt);

      return ok({ assignment });
    },
  );

  // POST /projects/:projectId/assignments/select-observer
  fastify.post<{
    Params: { projectId: string };
    Body: { objectiveId?: string; strategy?: string };
  }>(
    "/projects/:projectId/assignments/select-observer",
    {
      schema: {
        tags: ["Assignments"],
        summary: "Auto-select observer for project",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        body: {
          type: "object",
          properties: {
            objectiveId: { type: "string" },
            strategy: { type: "string", enum: ["first_available", "round_robin", "random"] },
          },
        },
        response: { 200: envelope() },
      },
    },
    async (request) => {
      const strategy = request.body.strategy ?? "first_available";
      const agents = await fastify.concord.agents.listAgents();

      // Select agents eligible for observer role
      const eligible = agents.filter((a) =>
        a.eligibleRoles.includes("observer" as never)
      );

      if (eligible.length === 0) {
        return ok({ assignments: [], message: "No eligible observers available" });
      }

      let selected = eligible[0]!;
      if (strategy === "random") {
        selected = eligible[Math.floor(Math.random() * eligible.length)]!;
      }

      const now = new Date().toISOString();
      const assignment: Assignment = {
        id: `assign_${uuidv4().replace(/-/g, "").slice(0, 16)}`,
        projectId: request.params.projectId,
        role: "observer",
        actorId: selected.id,
        scope: request.body.objectiveId ? { objectiveId: request.body.objectiveId } : undefined,
        reason: `Auto-selected via ${strategy}`,
        status: "active",
        createdAt: now,
      };

      const lease = await fastify.coordinatorStore.createLease({
        kind: "role:observer",
        resourceId: `${request.params.projectId}:${request.body.objectiveId ?? "all"}`,
        holderId: selected.id,
        ttlMs: 3600 * 1000,
      });
      assignment.leaseId = lease.id;
      await fastify.coordinatorStore.saveProjection("assignment", assignment.id, assignment);

      const { createEvent } = await import("@concord/foundation");
      const evt = createEvent({ type: "RoleAssigned", payload: assignment });
      await fastify.concord.state.events.append(evt);
      fastify.eventBus.publish(evt);

      return ok({ assignments: [assignment] });
    },
  );

  // GET /projects/:projectId/assignments
  fastify.get<{ Params: { projectId: string }; Querystring: { role?: string; actorId?: string; limit?: string; cursor?: string } }>(
    "/projects/:projectId/assignments",
    {
      schema: {
        tags: ["Assignments"],
        summary: "List assignments for a project",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        querystring: {
          type: "object",
          properties: {
            role: { type: "string" },
            actorId: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: { 200: listEnvelope() },
      },
    },
    async (request) => {
      const { role, actorId, limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);
      const allAssignments = await fastify.coordinatorStore.listProjections<Assignment>("assignment");
      let assignments = allAssignments.filter((a) => a.projectId === request.params.projectId);
      if (role) assignments = assignments.filter((a) => a.role === role);
      if (actorId) assignments = assignments.filter((a) => a.actorId === actorId);

      let startIdx = 0;
      if (cursor) {
        const idx = assignments.findIndex((a) => a.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = assignments.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // POST /leases/:leaseId/renew
  fastify.post<{
    Params: { leaseId: string };
    Body: { ttlSeconds?: number };
  }>(
    "/leases/:leaseId/renew",
    {
      schema: {
        tags: ["Assignments"],
        summary: "Renew a lease",
        params: { type: "object", required: ["leaseId"], properties: { leaseId: { type: "string" } } },
        body: {
          type: "object",
          properties: { ttlSeconds: { type: "number" } },
        },
        response: { 200: envelopeKey("lease") },
      },
    },
    async (request) => {
      const ttlMs = (request.body?.ttlSeconds ?? 3600) * 1000;
      const lease = await fastify.coordinatorStore.renewLease(request.params.leaseId, ttlMs);
      if (!lease) throw notFound("Lease", request.params.leaseId);
      return ok({ lease });
    },
  );

  // POST /leases/:leaseId/release
  fastify.post<{ Params: { leaseId: string } }>(
    "/leases/:leaseId/release",
    {
      schema: {
        tags: ["Assignments"],
        summary: "Release a lease",
        params: { type: "object", required: ["leaseId"], properties: { leaseId: { type: "string" } } },
        response: { 200: envelope() },
      },
    },
    async (request) => {
      await fastify.coordinatorStore.releaseLease(request.params.leaseId);
      return ok({ released: true });
    },
  );

  // POST /leases/sweep — sweep expired leases
  fastify.post(
    "/leases/sweep",
    {
      schema: {
        tags: ["Assignments"],
        summary: "Sweep expired leases (dev/admin)",
        response: { 200: envelope(), 403: errorEnvelope },
      },
    },
    async (_request, reply) => {
      if (!fastify.config.enableDevRoutes) {
        return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: "Dev routes disabled" }, meta: { requestId: "" } });
      }
      const expired = await fastify.coordinatorStore.sweepExpiredLeases();
      const { createEvent } = await import("@concord/foundation");
      for (const lease of expired) {
        const evt = createEvent({ type: "LeaseExpired", payload: lease });
        await fastify.concord.state.events.append(evt);
        fastify.eventBus.publish(evt);
      }
      return ok({ swept: expired.length, expired });
    },
  );
};

export default assignmentsRoutes;
