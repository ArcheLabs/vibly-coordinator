import type { FastifyPluginAsync } from "fastify";
import type { CoordinatorConfig } from "../../../config/env.js";
import { ok } from "../../../domain/apiTypes.js";
import { notFound } from "../../../domain/errors.js";
import { getNetworkManifest, getNetworkManifests } from "./manifest.js";

export interface NetworkRoutesOptions {
  config: CoordinatorConfig;
}

const chainSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    chainId: { type: "string" as const },
    genesisHash: { type: "string" as const },
    rpcUrls: { type: "array" as const, items: { type: "string" as const } },
    tokenSymbol: { type: "string" as const },
    tokenDecimals: { type: "number" as const },
    explorerTxUrl: { type: "string" as const },
    status: { type: "string" as const },
  },
  required: ["chainId", "rpcUrls"],
};

const manifestSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    manifestVersion: { type: "number" as const },
    updatedAt: { type: "string" as const },
    ttlSeconds: { type: "number" as const },
    id: { type: "string" as const },
    label: { type: "string" as const },
    stage: { type: "string" as const },
    status: { type: "string" as const },
    coordinatorUrls: { type: "array" as const, items: { type: "string" as const } },
    chains: {
      type: "object" as const,
      additionalProperties: false,
      properties: { vibly: chainSchema },
      required: ["vibly"],
    },
    features: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        agentJoin: { type: "boolean" as const },
        daemon: { type: "boolean" as const },
        staking: { type: "boolean" as const },
        rootIdentityRegistration: { type: "boolean" as const },
      },
      required: ["agentJoin", "daemon", "staking", "rootIdentityRegistration"],
    },
    messages: { type: "object" as const, additionalProperties: { type: "string" as const } },
    minimumClientVersion: { type: "string" as const },
    recommendedClientVersion: { type: "string" as const },
  },
  required: [
    "manifestVersion",
    "updatedAt",
    "ttlSeconds",
    "id",
    "label",
    "stage",
    "status",
    "coordinatorUrls",
    "chains",
    "features",
  ],
};

const networksRoutes: FastifyPluginAsync<NetworkRoutesOptions> = async (fastify, opts) => {
  fastify.get(
    "/networks",
    {
      schema: {
        tags: ["Health"],
        summary: "List public Vibly network manifests",
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: { networks: { type: "array", items: manifestSchema } },
                required: ["networks"],
              },
            },
          },
        },
      },
    },
    async () => ok({ networks: getNetworkManifests(opts.config) }),
  );

  fastify.get<{ Params: { networkId: string } }>(
    "/networks/:networkId",
    {
      schema: {
        tags: ["Health"],
        summary: "Get one public Vibly network manifest",
        params: {
          type: "object",
          properties: { networkId: { type: "string" } },
          required: ["networkId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              data: {
                type: "object",
                properties: { network: manifestSchema },
                required: ["network"],
              },
            },
          },
        },
      },
    },
    async (request) => {
      const network = getNetworkManifest(opts.config, request.params.networkId);
      if (!network) throw notFound("Network", request.params.networkId);
      return ok({ network });
    },
  );
};

export default networksRoutes;
