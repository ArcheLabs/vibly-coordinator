import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { envelopeKey, listEnvelope } from "../../../domain/schemas.js";

const principalsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /principals
  fastify.post<{
    Body: {
      kind: string;
      displayName: string;
      description?: string;
      identityBindings?: unknown[];
      addressBindings?: unknown[];
    };
  }>(
    "/principals",
    {
      schema: {
        tags: ["Principals"],
        summary: "Register a principal",
        body: {
          type: "object",
          required: ["kind", "displayName"],
          properties: {
            kind: { type: "string" },
            displayName: { type: "string" },
            description: { type: "string" },
            identityBindings: { type: "array" },
            addressBindings: { type: "array" },
          },
        },
        response: { 200: envelopeKey("principal") },
      },
    },
    async (request) => {
      const principal = await fastify.concord.principals.registerPrincipal({
        kind: request.body.kind as never,
        displayName: request.body.displayName,
        description: request.body.description,
        identityBindings: (request.body.identityBindings ?? []) as never,
        addressBindings: (request.body.addressBindings ?? []) as never,
      });
      return ok({ principal });
    },
  );

  // GET /principals
  fastify.get<{ Querystring: { kind?: string; status?: string; limit?: string; cursor?: string } }>(
    "/principals",
    {
      schema: {
        tags: ["Principals"],
        summary: "List principals",
        querystring: {
          type: "object",
          properties: {
            kind: { type: "string" },
            status: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: { 200: listEnvelope() },
      },
    },
    async (request) => {
      const { kind, status, limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);
      let principals = await fastify.concord.principals.listPrincipals();
      if (kind) principals = principals.filter((p) => p.kind === kind);
      if (status) principals = principals.filter((p) => p.status === status);

      let startIdx = 0;
      if (cursor) {
        const idx = principals.findIndex((p) => p.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = principals.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // GET /principals/:principalId
  fastify.get<{ Params: { principalId: string } }>(
    "/principals/:principalId",
    {
      schema: {
        tags: ["Principals"],
        summary: "Get a principal",
        params: { type: "object", required: ["principalId"], properties: { principalId: { type: "string" } } },
        response: { 200: envelopeKey("principal") },
      },
    },
    async (request) => {
      const principal = await fastify.concord.principals.getPrincipal(request.params.principalId as never);
      if (!principal) throw notFound("Principal", request.params.principalId);
      return ok({ principal });
    },
  );

  // POST /principals/:principalId/identities — bind an on-chain address
  fastify.post<{
    Params: { principalId: string };
    Body: {
      chain: string;
      address: string;
      publicKey?: string;
      proof?: { uri: string };
      status?: string;
    };
  }>(
    "/principals/:principalId/identities",
    {
      schema: {
        tags: ["Principals"],
        summary: "Bind an address to principal",
        params: { type: "object", required: ["principalId"], properties: { principalId: { type: "string" } } },
        body: {
          type: "object",
          required: ["chain", "address"],
          properties: {
            chain: { type: "string" },
            address: { type: "string" },
            publicKey: { type: "string" },
            proof: { type: "object", properties: { uri: { type: "string" } } },
            status: { type: "string" },
          },
        },
        response: { 200: envelopeKey("addressBinding") },
      },
    },
    async (request) => {
      const binding = await fastify.concord.principals.bindAddress({
        principalId: request.params.principalId as never,
        chain: request.body.chain,
        address: request.body.address,
        publicKey: request.body.publicKey,
        proof: request.body.proof as never,
        status: (request.body.status ?? "pending") as never,
      });
      return ok({ addressBinding: binding });
    },
  );

  // POST /principals/:principalId/status
  fastify.post<{
    Params: { principalId: string };
    Body: { nextStatus: string; reason: string };
  }>(
    "/principals/:principalId/status",
    {
      schema: {
        tags: ["Principals"],
        summary: "Change principal status",
        params: { type: "object", required: ["principalId"], properties: { principalId: { type: "string" } } },
        body: {
          type: "object",
          required: ["nextStatus", "reason"],
          properties: {
            nextStatus: { type: "string" },
            reason: { type: "string" },
          },
        },
        response: { 200: envelopeKey("principal") },
      },
    },
    async (request) => {
      const principal = await fastify.concord.principals.changePrincipalStatus({
        principalId: request.params.principalId as never,
        nextStatus: request.body.nextStatus as never,
        reason: request.body.reason,
      });
      return ok({ principal });
    },
  );
};

export default principalsRoutes;
