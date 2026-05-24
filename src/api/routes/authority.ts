/**
 * GET /authority/guardian/status — list chain Guardian snapshot.
 * GET /authority/guardian/me     — check a specific account's Guardian status.
 */

import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { envelope, envelopeKey } from "../../domain/schemas.js";
import { authPolicy } from "../../plugins/authPolicy.js";
import type { ChainAuthorityResolver } from "../../services/chainAuthorityResolver.js";

export interface AuthorityRoutesOptions {
  authorityResolver: ChainAuthorityResolver;
}

const authorityRoutes: FastifyPluginAsync<AuthorityRoutesOptions> = async (
  fastify,
  { authorityResolver },
) => {
  // ─── GET /authority/guardian/status ───────────────────────────────────────

  fastify.get(
    "/authority/guardian/status",
    {
      ...authPolicy("public-read", {
        tags: ["Authority"],
        summary: "Guardian authority snapshot",
        description:
          "Returns the cached chain Guardian member set with mode, block metadata, " +
          "and staleness flag. In `disabled` mode the list is always empty.",
        response: {
          200: envelope({
            type: "object",
            required: ["mode", "chainId", "guardians", "stale"],
            properties: {
              mode: { type: "string" },
              chainId: { type: "string" },
              guardians: { type: "array", items: { type: "string" } },
              blockHash: { type: "string" },
              blockNumber: { type: "string" },
              lastSyncAt: { type: "string" },
              stale: { type: "boolean" },
              error: { type: "string" },
            },
          }),
        },
      }),
    },
    async () => {
      const snapshot = await authorityResolver.listGuardians();
      return ok(snapshot);
    },
  );

  // ─── GET /authority/guardian/me ───────────────────────────────────────────

  fastify.get<{ Querystring: { accountId?: string } }>(
    "/authority/guardian/me",
    {
      ...authPolicy("public-read", {
        tags: ["Authority"],
        summary: "Check Guardian status for an account",
        description:
          "Returns a Guardian authority decision for the given account ID. " +
          "Pass `?accountId=5Grp...` or omit to check the authenticated principal.",
        querystring: {
          type: "object",
          properties: { accountId: { type: "string" } },
        },
        response: {
          200: envelopeKey("decision", {
            type: "object",
            required: ["accountId", "isGuardian", "source", "chainId", "observedAt", "stale"],
            properties: {
              accountId: { type: "string" },
              isGuardian: { type: "boolean" },
              source: { type: "string" },
              chainId: { type: "string" },
              blockHash: { type: "string" },
              blockNumber: { type: "string" },
              observedAt: { type: "string" },
              stale: { type: "boolean" },
            },
          }),
        },
      }),
    },
    async (request) => {
      const accountId = request.query.accountId ?? "unknown";
      const decision = await authorityResolver.isGuardian(accountId);
      return ok({ decision });
    },
  );
};

export default authorityRoutes;
