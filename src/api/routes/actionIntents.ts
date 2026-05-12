/**
 * POST /action-intents — unified write entry point for all v0.2 domain
 * operations.
 *
 * Replaces the scattered POST /actions, POST /work-orders, POST /reviews,
 * etc.  Old routes remain registered with `deprecated: true` until they are
 * removed in Phase 5.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ok } from "../../domain/apiTypes.js";
import { badRequest } from "../../domain/errors.js";
import { actionIntentResultSchema } from "../../domain/schemas.js";
import type { ActionIntentDispatcher } from "../../application/actionIntentDispatcher.js";
import type { ActionIntentType } from "../../application/types.js";

const bodySchema = z.object({
  type: z.string().min(1),
  principalId: z.string().min(1),
  organizationId: z.string().optional(),
  projectId: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
  idempotencyKey: z.string().optional(),
});

export interface ActionIntentsPluginOptions {
  dispatcher: ActionIntentDispatcher;
}

const actionIntentsRoutes: FastifyPluginAsync<ActionIntentsPluginOptions> = async (
  fastify,
  { dispatcher },
) => {
  fastify.post<{ Body: unknown }>(
    "/action-intents",
    {
      schema: {
        tags: ["ActionIntents"],
        summary: "Submit an ActionIntent (unified write path)",
        description:
          "All v0.2 write operations pass through this endpoint. " +
          "The `type` field routes the intent to the appropriate handler. " +
          "On success the response contains the primary event produced.",
        body: {
          type: "object",
          required: ["type", "principalId"],
          properties: {
            type: { type: "string", minLength: 1 },
            principalId: { type: "string", minLength: 1 },
            organizationId: { type: "string" },
            projectId: { type: "string" },
            payload: { type: "object", additionalProperties: true },
            idempotencyKey: { type: "string" },
          },
        },
        response: { 200: actionIntentResultSchema },
      },
    },
    async (request) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Invalid action-intent body", parsed.error.flatten());
      }

      const intent = parsed.data;

      const result = await dispatcher.dispatch(
        {
          type: intent.type as ActionIntentType,
          principalId: intent.principalId,
          organizationId: intent.organizationId,
          projectId: intent.projectId,
          payload: intent.payload,
          idempotencyKey: intent.idempotencyKey,
        },
        {
          store: fastify.coordinatorStore,
          eventBus: fastify.eventBus,
          config: fastify.config,
          concord: fastify.concord,
          principalId: intent.principalId,
        },
      );

      return ok(result);
    },
  );
};

export default actionIntentsRoutes;
