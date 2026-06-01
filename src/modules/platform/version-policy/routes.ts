import type { FastifyPluginAsync } from "fastify";
import type { CoordinatorConfig } from "../../../config/env.js";
import { ok } from "../../../domain/apiTypes.js";
import { getVersionPolicy } from "./policy.js";

export interface VersionPolicyRoutesOptions {
  config: CoordinatorConfig;
}

const RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    ok: { type: "boolean" as const },
    data: {
      type: "object" as const,
      properties: {
        policy: {
          type: "object" as const,
          properties: {
            minimumClientVersion: { type: "string" as const },
            recommendedClientVersion: { type: "string" as const },
            minimumContractVersion: { type: "string" as const },
            upgradeDeadline: { type: "string" as const },
            upgradeInstructionsUrl: { type: "string" as const },
            protocolVersion: { type: "string" as const },
            enforcement: { type: "boolean" as const },
          },
          required: ["minimumClientVersion", "recommendedClientVersion", "minimumContractVersion", "upgradeInstructionsUrl", "protocolVersion", "enforcement"],
        },
      },
    },
  },
};

const versionPolicyRoutes: FastifyPluginAsync<VersionPolicyRoutesOptions> = async (fastify, opts) => {
  fastify.get(
    "/version-policy",
    {
      schema: {
        tags: ["Health"],
        summary: "Get coordinator client version policy",
        response: { 200: RESPONSE_SCHEMA },
      },
    },
    async () => ok({ policy: getVersionPolicy(opts.config) }),
  );
};

export default versionPolicyRoutes;
