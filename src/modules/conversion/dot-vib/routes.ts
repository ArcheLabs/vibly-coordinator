import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../../domain/apiTypes.js";
import { envelopeKey } from "../../../domain/schemas.js";
import { notFound } from "../../../domain/errors.js";
import {
  CONVERSION_ORDER,
  completedConversionTotal,
  getConversionConfig,
  makeId,
  normalizeEvmAddress,
  quoteVibAmount,
  type ConversionOrderRecord,
} from "../../identity/onboarding/domain.js";

const dotVibRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { dotAmount: string } }>(
    "/conversion/dot-vib/quote",
    {
      schema: {
        tags: ["Conversion"],
        summary: "Quote DOT to VIB conversion",
        body: { type: "object", required: ["dotAmount"], properties: { dotAmount: { type: "string" } } },
        response: { 200: envelopeKey("quote") },
      },
    },
    async (request) => {
      const config = await getConversionConfig(fastify.coordinatorStore, fastify.config);
      const issued = await completedConversionTotal(fastify.coordinatorStore);
      const vibAmount = quoteVibAmount(request.body.dotAmount, config, issued);
      return ok({
        quote: {
          dotAmount: request.body.dotAmount,
          vibAmount,
          dotReceivingAddress: config.dotReceivingAddress,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      });
    },
  );

  fastify.post<{ Body: { dotAmount: string; viblyRootAddress: string; evmAddress?: string; identityId?: string } }>(
    "/conversion/dot-vib/orders",
    {
      schema: {
        tags: ["Conversion"],
        summary: "Create a DOT to VIB conversion order",
        body: {
          type: "object",
          required: ["dotAmount", "viblyRootAddress"],
          properties: {
            dotAmount: { type: "string" },
            viblyRootAddress: { type: "string" },
            evmAddress: { type: "string" },
            identityId: { type: "string" },
          },
        },
        response: { 200: envelopeKey("order") },
      },
    },
    async (request) => {
      const config = await getConversionConfig(fastify.coordinatorStore, fastify.config);
      const issued = await completedConversionTotal(fastify.coordinatorStore);
      const quotedVibAmount = quoteVibAmount(request.body.dotAmount, config, issued);
      const now = new Date().toISOString();
      const id = makeId("dotvib");
      const order: ConversionOrderRecord = {
        id,
        evmAddress: request.body.evmAddress ? normalizeEvmAddress(request.body.evmAddress) : undefined,
        identityId: request.body.identityId,
        viblyRootAddress: request.body.viblyRootAddress,
        dotAmount: request.body.dotAmount,
        quotedVibAmount,
        memo: id,
        dotReceivingAddress: config.dotReceivingAddress,
        quoteExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        status: "pending_payment",
        createdAt: now,
        updatedAt: now,
      };
      await fastify.coordinatorStore.saveProjection(CONVERSION_ORDER, id, order);
      return ok({ order });
    },
  );

  fastify.get<{ Params: { orderId: string } }>(
    "/conversion/dot-vib/orders/:orderId",
    {
      schema: {
        tags: ["Conversion"],
        summary: "Get DOT to VIB conversion order",
        params: { type: "object", required: ["orderId"], properties: { orderId: { type: "string" } } },
        response: { 200: envelopeKey("order") },
      },
    },
    async (request) => {
      const order = await fastify.coordinatorStore.getProjection<ConversionOrderRecord>(CONVERSION_ORDER, request.params.orderId);
      if (!order) throw notFound("Conversion order", request.params.orderId);
      return ok({ order });
    },
  );
};

export default dotVibRoutes;
