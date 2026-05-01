import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { envelopeKey, listEnvelope } from "../../../domain/schemas.js";

const agentsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /agents
  fastify.post<{
    Body: {
      principalId: string;
      displayName: string;
      description?: string;
      capabilities?: unknown[];
      eligibleRoles?: string[];
      metadata?: Record<string, unknown>;
    };
  }>(
    "/agents",
    {
      schema: {
        tags: ["Agents"],
        summary: "Register a new agent",
        body: {
          type: "object",
          required: ["principalId", "displayName"],
          properties: {
            principalId: { type: "string" },
            displayName: { type: "string" },
            description: { type: "string" },
            capabilities: { type: "array" },
            eligibleRoles: { type: "array", items: { type: "string" } },
            metadata: { type: "object" },
          },
        },
        response: { 200: envelopeKey("agent") },
      },
    },
    async (request) => {
      const agent = await fastify.concord.agents.registerAgent({
        principalId: request.body.principalId as never,
        displayName: request.body.displayName,
        description: request.body.description,
        capabilities: (request.body.capabilities ?? []) as never,
        eligibleRoles: (request.body.eligibleRoles ?? []) as never,
        metadata: request.body.metadata,
      });
      return ok({ agent });
    },
  );

  // GET /agents
  fastify.get<{ Querystring: { principalId?: string; status?: string; limit?: string; cursor?: string } }>(
    "/agents",
    {
      schema: {
        tags: ["Agents"],
        summary: "List agents",
        querystring: {
          type: "object",
          properties: {
            principalId: { type: "string" },
            status: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: { 200: listEnvelope() },
      },
    },
    async (request) => {
      const { principalId, status, limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);
      let agents = await fastify.concord.agents.listAgents();
      if (principalId) agents = agents.filter((a) => String(a.principalId) === principalId);
      if (status) agents = agents.filter((a) => a.status === status);

      let startIdx = 0;
      if (cursor) {
        const idx = agents.findIndex((a) => a.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = agents.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // GET /agents/:agentId
  fastify.get<{ Params: { agentId: string } }>(
    "/agents/:agentId",
    {
      schema: {
        tags: ["Agents"],
        summary: "Get an agent",
        params: { type: "object", required: ["agentId"], properties: { agentId: { type: "string" } } },
        response: { 200: envelopeKey("agent") },
      },
    },
    async (request) => {
      const agent = await fastify.concord.agents.getAgent(request.params.agentId as never);
      if (!agent) throw notFound("Agent", request.params.agentId);
      return ok({ agent });
    },
  );

  // POST /agents/:agentId/status
  fastify.post<{
    Params: { agentId: string };
    Body: { status: string; reason: string };
  }>(
    "/agents/:agentId/status",
    {
      schema: {
        tags: ["Agents"],
        summary: "Change agent status",
        params: { type: "object", required: ["agentId"], properties: { agentId: { type: "string" } } },
        body: {
          type: "object",
          required: ["status", "reason"],
          properties: {
            status: { type: "string" },
            reason: { type: "string" },
          },
        },
        response: { 200: envelopeKey("agent") },
      },
    },
    async (request) => {
      const agent = await fastify.concord.agents.changeAgentStatus({
        agentId: request.params.agentId as never,
        nextStatus: request.body.status as never,
        reason: request.body.reason,
      });
      return ok({ agent });
    },
  );

  // POST /agents/:agentId/runtime-bindings
  fastify.post<{
    Params: { agentId: string };
    Body: {
      runtimeKind: string;
      runtimeAdapterId: string;
      capabilities?: unknown[];
      permissionScope?: unknown;
      endpoint?: unknown;
    };
  }>(
    "/agents/:agentId/runtime-bindings",
    {
      schema: {
        tags: ["Agents"],
        summary: "Create runtime binding for agent",
        params: { type: "object", required: ["agentId"], properties: { agentId: { type: "string" } } },
        body: {
          type: "object",
          required: ["runtimeKind", "runtimeAdapterId"],
          properties: {
            runtimeKind: { type: "string" },
            runtimeAdapterId: { type: "string" },
            capabilities: { type: "array" },
            permissionScope: { type: "object" },
            endpoint: { type: "object" },
          },
        },
        response: { 200: envelopeKey("runtimeBinding") },
      },
    },
    async (request) => {
      const binding = await fastify.concord.agents.createRuntimeBinding({
        agentId: request.params.agentId as never,
        runtimeKind: request.body.runtimeKind as never,
        runtimeAdapterId: request.body.runtimeAdapterId,
        capabilities: (request.body.capabilities ?? []) as never,
        permissionScope: request.body.permissionScope as never,
        endpoint: request.body.endpoint as never,
      });
      return ok({ runtimeBinding: binding });
    },
  );

  // GET /agents/:agentId/runtime-bindings
  fastify.get<{ Params: { agentId: string } }>(
    "/agents/:agentId/runtime-bindings",
    {
      schema: {
        tags: ["Agents"],
        summary: "List runtime bindings for agent",
        params: { type: "object", required: ["agentId"], properties: { agentId: { type: "string" } } },
        response: { 200: listEnvelope() },
      },
    },
    async (request) => {
      const events = await fastify.concord.state.events.query({ type: ["RuntimeBindingCreated"] });
      const bindings = events
        .map((e) => (e.payload as { binding?: unknown }).binding)
        .filter((b) => b && (b as { agentId?: string }).agentId === request.params.agentId);
      return okList(bindings, { limit: bindings.length, nextCursor: null });
    },
  );

  // DELETE /agents/:agentId/runtime-bindings/:bindingId
  fastify.delete<{ Params: { agentId: string; bindingId: string }; Body: { reason: string } }>(
    "/agents/:agentId/runtime-bindings/:bindingId",
    {
      schema: {
        tags: ["Agents"],
        summary: "Revoke a runtime binding",
        params: {
          type: "object",
          required: ["agentId", "bindingId"],
          properties: { agentId: { type: "string" }, bindingId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["reason"],
          properties: { reason: { type: "string" } },
        },
        response: { 200: envelopeKey("runtimeBinding") },
      },
    },
    async (request) => {
      const binding = await fastify.concord.agents.revokeRuntimeBinding({
        runtimeBindingId: request.params.bindingId as never,
        reason: request.body.reason,
      });
      return ok({ runtimeBinding: binding });
    },
  );
};

export default agentsRoutes;
