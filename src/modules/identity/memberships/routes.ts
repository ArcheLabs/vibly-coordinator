import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { envelopeKey, listEnvelope } from "../../../domain/schemas.js";
import { authPolicy } from "../../../plugins/authPolicy.js";

const membershipsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /projects/:projectId/members
  fastify.post<{
    Params: { projectId: string };
    Body: {
      principalId: string;
      agentId?: string;
      roles: string[];
      source?: string;
    };
  }>(
    "/projects/:projectId/members",
    {
      ...authPolicy("wallet-session", {
        tags: ["Memberships"],
        summary: "Add a member to a project",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        body: {
          type: "object",
          required: ["principalId", "roles"],
          properties: {
            principalId: { type: "string" },
            agentId: { type: "string" },
            roles: { type: "array", items: { type: "string" } },
            source: { type: "string" },
          },
        },
        response: { 200: envelopeKey("membership") },
      }),
    },
    async (request) => {
      const membership = await fastify.concord.agents.addProjectMember({
        projectId: request.params.projectId as never,
        principalId: request.body.principalId as never,
        agentId: request.body.agentId as never,
        roles: request.body.roles as never,
        source: (request.body.source ?? "manual") as never,
      });
      return ok({ membership });
    },
  );

  // GET /projects/:projectId/members
  fastify.get<{
    Params: { projectId: string };
    Querystring: { status?: string; role?: string; limit?: string; cursor?: string };
  }>(
    "/projects/:projectId/members",
    {
      ...authPolicy("wallet-session", {
        tags: ["Memberships"],
        summary: "List project members",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        querystring: {
          type: "object",
          properties: {
            status: { type: "string" },
            role: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: { 200: listEnvelope() },
      }),
    },
    async (request) => {
      const { status, role, limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);
      let members = await fastify.concord.agents.listProjectMembers(request.params.projectId as never);
      if (status) members = members.filter((m) => m.status === status);
      if (role) members = members.filter((m) => m.roles.includes(role as never));

      let startIdx = 0;
      if (cursor) {
        const idx = members.findIndex((m) => m.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = members.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // DELETE /projects/:projectId/members/:principalId
  fastify.delete<{
    Params: { projectId: string; principalId: string };
    Body: { membershipId: string; reason: string };
  }>(
    "/projects/:projectId/members/:principalId",
    {
      ...authPolicy("wallet-session", {
        tags: ["Memberships"],
        summary: "Remove a member from a project",
        params: {
          type: "object",
          required: ["projectId", "principalId"],
          properties: { projectId: { type: "string" }, principalId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["membershipId", "reason"],
          properties: {
            membershipId: { type: "string" },
            reason: { type: "string" },
          },
        },
        response: { 200: envelopeKey("membership") },
      }),
    },
    async (request) => {
      const members = await fastify.concord.agents.listProjectMembers(request.params.projectId as never);
      const membership = members.find((m) => String(m.principalId) === request.params.principalId);
      if (!membership) throw notFound("Membership", `${request.params.projectId}:${request.params.principalId}`);

      const updated = await fastify.concord.agents.changeMembershipStatus({
        membershipId: membership.id,
        nextStatus: "removed",
        reason: request.body.reason,
      });
      return ok({ membership: updated });
    },
  );
};

export default membershipsRoutes;
