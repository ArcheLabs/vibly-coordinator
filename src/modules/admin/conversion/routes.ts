import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../../domain/apiTypes.js";
import { envelopeKey } from "../../../domain/schemas.js";
import { badRequest, notFound } from "../../../domain/errors.js";
import {
  CONVERSION_CONFIG,
  CONVERSION_ORDER,
  completedConversionTotal,
  getConversionConfig,
  quoteVibAmount,
  type ConversionConfigRecord,
  type ConversionOrderRecord,
} from "../../identity/onboarding/domain.js";

const adminConversionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.put<{
    Body: {
      totalCapVib: string;
      initialRate: string;
      slope: string;
      minDot: string;
      maxDot: string;
      dotReceivingAddress: string;
    };
  }>(
    "/admin/conversion/dot-vib/config",
    {
      schema: {
        tags: ["Admin"],
        summary: "Update DOT to VIB conversion configuration",
        body: {
          type: "object",
          required: ["totalCapVib", "initialRate", "slope", "minDot", "maxDot", "dotReceivingAddress"],
          properties: {
            totalCapVib: { type: "string" },
            initialRate: { type: "string" },
            slope: { type: "string" },
            minDot: { type: "string" },
            maxDot: { type: "string" },
            dotReceivingAddress: { type: "string" },
          },
        },
        response: { 200: envelopeKey("config") },
      },
    },
    async (request) => {
      const config: ConversionConfigRecord = { ...request.body, updatedAt: new Date().toISOString() };
      await fastify.coordinatorStore.saveProjection(CONVERSION_CONFIG, "active", config);
      return ok({ config });
    },
  );

  fastify.get(
    "/admin/conversion/dot-vib/status",
    {
      schema: {
        tags: ["Admin"],
        summary: "Get DOT to VIB conversion operational status",
        response: { 200: envelopeKey("status") },
      },
    },
    async () => {
      const config = await getConversionConfig(fastify.coordinatorStore, fastify.config);
      const issuedVib = await completedConversionTotal(fastify.coordinatorStore);
      return ok({ status: { config, issuedVib: String(issuedVib) } });
    },
  );

  fastify.post<{ Params: { orderId: string }; Body: { paymentId: string; dotAmount: string; memo: string } }>(
    "/admin/conversion/dot-vib/orders/:orderId/finalize",
    {
      schema: {
        tags: ["Admin"],
        summary: "Mark a DOT payment finalized after memo-based matching",
        params: { type: "object", required: ["orderId"], properties: { orderId: { type: "string" } } },
        body: {
          type: "object",
          required: ["paymentId", "dotAmount", "memo"],
          properties: { paymentId: { type: "string" }, dotAmount: { type: "string" }, memo: { type: "string" } },
        },
        response: { 200: envelopeKey("order") },
      },
    },
    async (request) => {
      const order = await fastify.coordinatorStore.getProjection<ConversionOrderRecord>(CONVERSION_ORDER, request.params.orderId);
      if (!order) throw notFound("Conversion order", request.params.orderId);
      if (request.body.memo !== order.memo) throw badRequest("DOT payment memo does not match order memo");
      const config = await getConversionConfig(fastify.coordinatorStore, fastify.config);
      const finalVibAmount = quoteVibAmount(request.body.dotAmount, config, await completedConversionTotal(fastify.coordinatorStore));
      const now = new Date().toISOString();
      const updated: ConversionOrderRecord = {
        ...order,
        dotAmount: request.body.dotAmount,
        finalVibAmount,
        paymentId: request.body.paymentId,
        status: "completed",
        updatedAt: now,
      };
      await fastify.coordinatorStore.saveProjection(CONVERSION_ORDER, updated.id, updated);
      return ok({ order: updated });
    },
  );
};

export default adminConversionRoutes;
