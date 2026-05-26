import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { CoordinatorConfig } from "../../../config/env.js";
import { ok } from "../../../domain/apiTypes.js";
import { envelopeKey } from "../../../domain/schemas.js";
import {
  buildAndSaveManifest,
  createGetVibOrder,
  getAllocationSummary,
  getClaimProof,
  getCurve,
  getGetVibConfig,
  getOrder,
  getRelayWatcherState,
  getRecords,
  ingestFinalizedDeposit,
  listObservedRelayDeposits,
  quoteGetVibAmount,
  recordClaim,
} from "./domain.js";

function requestNetworkId(request: FastifyRequest, bodyNetworkId?: string): string | undefined {
  const header = request.headers["x-vibly-network-id"];
  const value = bodyNetworkId ?? (Array.isArray(header) ? header[0] : header);
  if (!value || !/^[a-zA-Z0-9:_./-]{1,128}$/.test(value)) return undefined;
  return value;
}

function configForRequest(config: CoordinatorConfig, request: FastifyRequest, bodyNetworkId?: string): CoordinatorConfig {
  const networkId = requestNetworkId(request, bodyNetworkId);
  return networkId ? { ...config, substrateChainId: networkId } : config;
}

const getVibRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/get-vib/config",
    {
      schema: {
        tags: ["Get VIB"],
        summary: "Get production Get VIB configuration for the active network",
        response: { 200: envelopeKey("config") },
      },
    },
    async (request) => ok({ config: await getGetVibConfig(fastify.coordinatorStore, configForRequest(fastify.config, request)) }),
  );

  fastify.get<{ Querystring: { amount: string } }>(
    "/get-vib/quote",
    {
      schema: {
        tags: ["Get VIB"],
        summary: "Quote DOT to VIB for the active network",
        querystring: {
          type: "object",
          required: ["amount"],
          properties: { amount: { type: "string" } },
        },
        response: { 200: envelopeKey("quote") },
      },
    },
    async (request) => ok({ quote: await quoteGetVibAmount(fastify.coordinatorStore, configForRequest(fastify.config, request), request.query.amount) }),
  );

  fastify.post<{ Body: { networkId?: string; dotAmount: string; accountId: string; identityId?: string; evmAddress?: string } }>(
    "/get-vib/orders",
    {
      schema: {
        tags: ["Get VIB"],
        summary: "Create a Get VIB DOT deposit order",
        body: {
          type: "object",
          required: ["dotAmount", "accountId"],
          properties: {
            dotAmount: { type: "string" },
            accountId: { type: "string" },
            networkId: { type: "string" },
            identityId: { type: "string" },
            evmAddress: { type: "string" },
          },
        },
        response: { 200: envelopeKey("order") },
      },
    },
    async (request) =>
      ok({
        order: await createGetVibOrder({
          store: fastify.coordinatorStore,
          config: configForRequest(fastify.config, request, request.body.networkId),
          dotAmount: request.body.dotAmount,
          accountId: request.body.accountId,
          identityId: request.body.identityId,
          evmAddress: request.body.evmAddress,
        }),
      }),
  );

  fastify.get<{ Params: { orderId: string } }>(
    "/get-vib/orders/:orderId",
    {
      schema: {
        tags: ["Get VIB"],
        summary: "Get a Get VIB DOT deposit order",
        params: { type: "object", required: ["orderId"], properties: { orderId: { type: "string" } } },
        response: { 200: envelopeKey("order") },
      },
    },
    async (request) => ok({ order: await getOrder(fastify.coordinatorStore, request.params.orderId) }),
  );

  fastify.get<{ Params: { accountId: string } }>(
    "/get-vib/account/:accountId/summary",
    {
      schema: {
        tags: ["Get VIB"],
        summary: "Get a user's Get VIB allocation summary",
        params: { type: "object", required: ["accountId"], properties: { accountId: { type: "string" } } },
        response: { 200: envelopeKey("summary") },
      },
    },
    async (request) =>
      ok({ summary: await getAllocationSummary(fastify.coordinatorStore, configForRequest(fastify.config, request), request.params.accountId) }),
  );

  fastify.get<{ Params: { accountId: string } }>(
    "/get-vib/account/:accountId/proof",
    {
      schema: {
        tags: ["Get VIB"],
        summary: "Get a user's current Get VIB Merkle claim proof",
        params: { type: "object", required: ["accountId"], properties: { accountId: { type: "string" } } },
        response: { 200: envelopeKey("proof") },
      },
    },
    async (request) => ok({ proof: await getClaimProof(fastify.coordinatorStore, configForRequest(fastify.config, request), request.params.accountId) }),
  );

  fastify.get<{ Params: { accountId: string } }>(
    "/get-vib/account/:accountId/records",
    {
      schema: {
        tags: ["Get VIB"],
        summary: "Get a user's Get VIB deposits, allocations, and claims",
        params: { type: "object", required: ["accountId"], properties: { accountId: { type: "string" } } },
        response: { 200: envelopeKey("records") },
      },
    },
    async (request) => ok({ records: await getRecords(fastify.coordinatorStore, configForRequest(fastify.config, request), request.params.accountId) }),
  );

  fastify.get(
    "/get-vib/curve",
    {
      schema: {
        tags: ["Get VIB"],
        summary: "Get Get VIB bonding curve display points",
        response: { 200: envelopeKey("curve") },
      },
    },
    async (request) => ok({ curve: await getCurve(fastify.coordinatorStore, configForRequest(fastify.config, request)) }),
  );

  fastify.post<{
    Body: {
      sourceId?: string;
      networkId?: string;
      dotAmount?: string;
      orderId?: string;
      observedDepositId?: string;
      accountId?: string;
      identityId?: string;
      paymentId?: string;
      finalizedAt?: string;
    };
  }>(
    "/admin/get-vib/deposits/finalize",
    {
      schema: {
        tags: ["Admin", "Get VIB"],
        summary: "Finalize an observed Relay Chain DOT deposit and create allocation",
        body: {
          type: "object",
          properties: {
            sourceId: { type: "string" },
            networkId: { type: "string" },
            dotAmount: { type: "string" },
            orderId: { type: "string" },
            observedDepositId: { type: "string" },
            accountId: { type: "string" },
            identityId: { type: "string" },
            paymentId: { type: "string" },
            finalizedAt: { type: "string" },
          },
        },
        response: { 200: envelopeKey("result") },
      },
    },
    async (request) =>
      ok({
        result: await ingestFinalizedDeposit({
          store: fastify.coordinatorStore,
          config: configForRequest(fastify.config, request, request.body.networkId),
          sourceId: request.body.sourceId,
          observedDepositId: request.body.observedDepositId,
          dotAmount: request.body.dotAmount,
          orderId: request.body.orderId,
          accountId: request.body.accountId,
          identityId: request.body.identityId,
          paymentId: request.body.paymentId,
          finalizedAt: request.body.finalizedAt,
        }),
      }),
  );

  fastify.get(
    "/admin/get-vib/relay-watcher/status",
    {
      schema: {
        tags: ["Admin", "Get VIB"],
        summary: "Get Get VIB relay deposit watcher status",
        response: { 200: envelopeKey("status") },
      },
    },
    async () =>
      ok({
        status: await getRelayWatcherState(fastify.coordinatorStore, fastify.config.getVibRelayChainId) ?? {
          id: fastify.config.getVibRelayChainId,
          relayChainId: fastify.config.getVibRelayChainId,
          status: "disabled",
          sourceUrl: fastify.config.getVibRelayRpcUrl,
          depositAddress: fastify.config.viblyDotReceivingAddress,
          observedCount: 0,
          updatedAt: new Date().toISOString(),
        },
      }),
  );

  fastify.get<{ Querystring: { status?: "observed" | "confirmed" | "failed"; limit?: number } }>(
    "/admin/get-vib/relay-deposits",
    {
      schema: {
        tags: ["Admin", "Get VIB"],
        summary: "List observed Get VIB Relay Chain deposits",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["observed", "confirmed", "failed"] },
            limit: { type: "integer", default: 50 },
          },
        },
        response: {
          200: envelopeKey("deposits", {
            type: "array",
            items: { type: "object", additionalProperties: true },
          }),
        },
      },
    },
    async (request) =>
      ok({
        deposits: await listObservedRelayDeposits(fastify.coordinatorStore, {
          status: request.query.status,
          limit: request.query.limit,
        }),
      }),
  );

  fastify.post(
    "/admin/get-vib/manifests",
    {
      schema: {
        tags: ["Admin", "Get VIB"],
        summary: "Build and persist the next cumulative Get VIB allocation manifest",
        response: { 200: envelopeKey("manifest") },
      },
    },
    async (request) => ok({ manifest: await buildAndSaveManifest(fastify.coordinatorStore, configForRequest(fastify.config, request)) }),
  );

  fastify.post<{
    Body: {
      accountId: string;
      networkId?: string;
      rootVersion: number;
      cumulativeAmount: string;
      claimedDelta: string;
      identityId?: string;
      txHash?: string;
      status?: "pending" | "confirmed" | "failed";
    };
  }>(
    "/admin/get-vib/claims",
    {
      schema: {
        tags: ["Admin", "Get VIB"],
        summary: "Record a Get VIB on-chain claim result",
        body: {
          type: "object",
          required: ["accountId", "rootVersion", "cumulativeAmount", "claimedDelta"],
          properties: {
            accountId: { type: "string" },
            networkId: { type: "string" },
            identityId: { type: "string" },
            rootVersion: { type: "integer" },
            cumulativeAmount: { type: "string" },
            claimedDelta: { type: "string" },
            txHash: { type: "string" },
            status: { type: "string", enum: ["pending", "confirmed", "failed"] },
          },
        },
        response: { 200: envelopeKey("claim") },
      },
    },
    async (request) =>
      ok({
        claim: await recordClaim({
          store: fastify.coordinatorStore,
          config: configForRequest(fastify.config, request, request.body.networkId),
          accountId: request.body.accountId,
          identityId: request.body.identityId,
          rootVersion: request.body.rootVersion,
          cumulativeAmount: request.body.cumulativeAmount,
          claimedDelta: request.body.claimedDelta,
          txHash: request.body.txHash,
          status: request.body.status,
        }),
      }),
  );
};

export default getVibRoutes;
