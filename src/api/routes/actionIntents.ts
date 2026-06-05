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
import { badRequest, forbidden } from "../../domain/errors.js";
import { actionIntentResultSchema } from "../../domain/schemas.js";
import type { ActionIntentDispatcher } from "../../application/actionIntentDispatcher.js";
import type { ActionIntentType } from "../../application/types.js";
import type { ChainAuthorityResolver } from "../../services/chainAuthorityResolver.js";
import { WALLET_SESSION, ensureActiveWalletSession, type WalletSessionRecord } from "../../modules/identity/wallet/domain.js";
import { authPolicy } from "../../plugins/authPolicy.js";

const bodySchema = z.object({
  type: z.string().min(1),
  principalId: z.string().min(1).optional(),
  organizationId: z.string().optional(),
  projectId: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
  idempotencyKey: z.string().optional(),
});

export interface ActionIntentsPluginOptions {
  dispatcher: ActionIntentDispatcher;
  authorityResolver: ChainAuthorityResolver;
}

function sessionTokenFromRequest(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers["x-wallet-session"];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

const actionIntentsRoutes: FastifyPluginAsync<ActionIntentsPluginOptions> = async (
  fastify,
  { dispatcher, authorityResolver },
) => {
  fastify.post<{ Body: unknown }>(
    "/action-intents",
    {
      ...authPolicy("wallet-session", {
        tags: ["ActionIntents"],
        summary: "Submit an ActionIntent (unified write path)",
        description:
          "All v0.2 write operations pass through this endpoint. " +
          "The `type` field routes the intent to the appropriate handler. " +
          "On success the response contains the primary event produced.",
        body: {
          type: "object",
          required: ["type"],
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
      }),
    },
    async (request) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Invalid action-intent body", parsed.error.flatten());
      }

      const intent = parsed.data;
      let actorPrincipalId = intent.principalId;
      const walletSessionToken = sessionTokenFromRequest(request.headers as Record<string, string | string[] | undefined>);
      if (walletSessionToken) {
        const session = ensureActiveWalletSession(
          await fastify.coordinatorStore.getProjection<WalletSessionRecord>(WALLET_SESSION, walletSessionToken),
          walletSessionToken,
        );
        actorPrincipalId = session.address;
      } else if (request.auth?.kind === "agent-runtime") {
        actorPrincipalId = request.auth.subject;
      } else if (request.auth?.kind === "oidc") {
        actorPrincipalId = request.auth.subject;
      }

      if (!actorPrincipalId) {
        throw badRequest("ActionIntent principalId is required when no wallet session or authenticated subject is present");
      }

      if (request.auth?.kind === "agent-runtime" && intent.principalId && request.auth.subject !== intent.principalId) {
        throw forbidden("Agent runtime token cannot submit for a different principal");
      }

      const result = await dispatcher.dispatch(
        {
          type: intent.type as ActionIntentType,
          principalId: actorPrincipalId,
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
          principalId: actorPrincipalId,
          authorityResolver,
        },
      );

      return ok(result);
    },
  );
};

export default actionIntentsRoutes;
