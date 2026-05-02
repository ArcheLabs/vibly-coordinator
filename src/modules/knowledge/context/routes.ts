import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { envelope, envelopeKey } from "../../../domain/schemas.js";

const contextRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /context/bundles
  fastify.post<{
    Body: {
      goalId: string;
      actorId: string;
      artifacts?: Array<{ uri: string; mediaType?: string }>;
    };
  }>(
    "/context/bundles",
    {
      schema: {
        tags: ["Context"],
        summary: "Create a context bundle",
        body: {
          type: "object",
          required: ["goalId", "actorId"],
          properties: {
            goalId: { type: "string" },
            actorId: { type: "string" },
            artifacts: { type: "array" },
          },
        },
        response: { 200: envelopeKey("contextBundle") },
      },
    },
    async (request) => {
      const bundle = await fastify.concord.context.createBundle({
        goalId: request.body.goalId as never,
        actorId: request.body.actorId as never,
        artifacts: (request.body.artifacts ?? []) as never,
      });
      const events = await fastify.concord.state.events.query({ type: ["ContextBundleCreated"] });
      const evt = events.find((e) => (e.payload as { id?: string })?.id === bundle.id);
      if (evt) fastify.eventBus.publish(evt);
      return ok({ contextBundle: bundle });
    },
  );

  // GET /context/bundles/:bundleId
  fastify.get<{ Params: { bundleId: string } }>(
    "/context/bundles/:bundleId",
    {
      schema: {
        tags: ["Context"],
        summary: "Get a context bundle",
        params: { type: "object", required: ["bundleId"], properties: { bundleId: { type: "string" } } },
        response: { 200: envelopeKey("contextBundle") },
      },
    },
    async (request) => {
      const bundle = await fastify.concord.context.getBundle(request.params.bundleId);
      if (!bundle) throw notFound("ContextBundle", request.params.bundleId);
      return ok({ contextBundle: bundle });
    },
  );

  // POST /context/receipts — accept a bundle, generating a receipt
  fastify.post<{
    Body: {
      actorId: string;
      contextBundleId: string;
    };
  }>(
    "/context/receipts",
    {
      schema: {
        tags: ["Context"],
        summary: "Accept a context bundle (issue receipt)",
        body: {
          type: "object",
          required: ["actorId", "contextBundleId"],
          properties: {
            actorId: { type: "string" },
            contextBundleId: { type: "string" },
          },
        },
        response: { 200: envelopeKey("receipt") },
      },
    },
    async (request) => {
      const receipt = await fastify.concord.context.acceptBundle({
        actorId: request.body.actorId as never,
        contextBundleId: request.body.contextBundleId,
      });
      return ok({ receipt });
    },
  );

  // POST /context/validate — validate a context receipt (stub)
  fastify.post<{ Body: { receipt: Record<string, unknown> } }>(
    "/context/validate",
    {
      schema: {
        tags: ["Context"],
        summary: "Validate a context receipt",
        body: {
          type: "object",
          required: ["receipt"],
          properties: { receipt: { type: "object" } },
        },
        response: { 200: envelope() },
      },
    },
    async (request) => {
      // Validate by checking the bundle exists
      const bundleId = (request.body.receipt as { contextBundleId?: string }).contextBundleId;
      if (!bundleId) {
        return ok({ valid: false, reason: "Missing contextBundleId in receipt" });
      }
      const bundle = await fastify.concord.context.getBundle(bundleId);
      return ok({ valid: !!bundle, bundleId, bundleFound: !!bundle });
    },
  );
};

export default contextRoutes;
