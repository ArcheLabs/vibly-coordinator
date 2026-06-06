import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { CoordinatorConfig } from "../../../config/env.js";
import type { CoordinatorStorePort } from "../../../db/coordinatorStorePort.js";
import { ok } from "../../../domain/apiTypes.js";
import { badRequest } from "../../../domain/errors.js";
import { envelopeKey } from "../../../domain/schemas.js";
import { authPolicy } from "../../../plugins/authPolicy.js";
import { getGetVibRootUploaderStatus } from "../../../services/getVibRootUploader.js";
import { GetVibRootChainActions } from "../../../services/getVibRootChainActions.js";
import { WALLET_SESSION, ensureActiveWalletSession, type WalletSessionRecord } from "../../identity/wallet/domain.js";
import {
  buildAndSaveManifest,
  createGetVibOrder,
  getAllocationSummary,
  getClaimProof,
  getCurve,
  getCurveState,
  getGetVibConfig,
  getOrder,
  getRelayWatcherState,
  getRecords,
  getVibAmountToBaseUnits,
  ingestFinalizedDeposit,
  listObservedRelayDeposits,
  quoteGetVibByBudget,
  quoteGetVibAmount,
  recordClaim,
  submitGetVibPayment,
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

function sessionTokenFromRequest(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers["x-wallet-session"];
  return Array.isArray(raw) ? raw[0] : raw;
}

async function requirePolkadotWalletSession(
  store: CoordinatorStorePort,
  headers: Record<string, string | string[] | undefined>,
): Promise<WalletSessionRecord> {
  const token = sessionTokenFromRequest(headers);
  if (!token) throw badRequest("Wallet session token is required");
  const session = ensureActiveWalletSession(await store.getProjection<WalletSessionRecord>(WALLET_SESSION, token), token);
  if (session.ecosystem !== "polkadot") {
    throw badRequest("Get VIB requires a Polkadot wallet session", { ecosystem: session.ecosystem });
  }
  return session;
}

const recordsSchema = {
  type: "object" as const,
  required: ["relayDeposits", "deposits", "allocations", "claims"],
  properties: {
    relayDeposits: {
      type: "array" as const,
      items: {
        type: "object" as const,
        additionalProperties: true,
        properties: {
          sourceId: { type: "string" as const },
          from: { type: "string" as const },
          to: { type: "string" as const },
          dotAmount: { type: "string" as const },
          paymentAmount: { type: "string" as const },
          extrinsicHash: { type: "string" as const },
          blockNumber: { type: "number" as const },
          finalizedAt: { type: "string" as const },
          status: { type: "string" as const },
          failureReason: { type: "string" as const },
          accountId: { type: "string" as const },
        },
      },
    },
    deposits: { type: "array" as const, items: { type: "object" as const, additionalProperties: true } },
    allocations: { type: "array" as const, items: { type: "object" as const, additionalProperties: true } },
    claims: { type: "array" as const, items: { type: "object" as const, additionalProperties: true } },
  },
  additionalProperties: true,
};

const getVibRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/get-vib/config",
    {
      ...authPolicy("public-read", {
        tags: ["Get VIB"],
        summary: "Get production Get VIB configuration for the active network",
        response: { 200: envelopeKey("config") },
      }),
    },
    async (request) => ok({ config: await getGetVibConfig(fastify.coordinatorStore, configForRequest(fastify.config, request)) }),
  );

  fastify.get<{ Querystring: { amount: string } }>(
    "/get-vib/quote",
    {
      ...authPolicy("public-read", {
        tags: ["Get VIB"],
        summary: "Quote DOT to VIB for the active network",
        querystring: {
          type: "object",
          required: ["amount"],
          properties: { amount: { type: "string" } },
        },
        response: { 200: envelopeKey("quote") },
      }),
    },
    async (request) => ok({ quote: await quoteGetVibAmount(fastify.coordinatorStore, configForRequest(fastify.config, request), request.query.amount) }),
  );

  fastify.get(
    "/get-vib/curve/state",
    {
      ...authPolicy("public-read", {
        tags: ["Get VIB"],
        summary: "Get Get VIB bonding curve state",
        response: { 200: envelopeKey("state") },
      }),
    },
    async (request) => ok({ state: await getCurveState(fastify.coordinatorStore, configForRequest(fastify.config, request)) }),
  );

  fastify.post<{
    Body: {
      networkId?: string;
      account?: string;
      accountId?: string;
      paymentAsset?: "DOT";
      budgetDot?: number;
      dotAmount?: string;
      vibAmount?: string;
    };
  }>(
    "/get-vib/curve/quote",
    {
      ...authPolicy("public-read", {
        tags: ["Get VIB"],
        summary: "Quote a DOT-denominated Get VIB curve purchase",
        body: {
          type: "object",
          properties: {
            networkId: { type: "string" },
            account: { type: "string" },
            accountId: { type: "string" },
            paymentAsset: { type: "string", enum: ["DOT"] },
            budgetDot: { type: "number" },
            dotAmount: { type: "string" },
            vibAmount: { type: "string" },
          },
        },
        response: { 200: envelopeKey("quote") },
      }),
    },
    async (request) =>
      ok({
        quote: await quoteGetVibByBudget({
          store: fastify.coordinatorStore,
          config: configForRequest(fastify.config, request, request.body.networkId),
          accountId: request.body.accountId ?? request.body.account,
          budgetDot: request.body.budgetDot,
          dotAmount: request.body.dotAmount,
          vibAmount: request.body.vibAmount,
        }),
      }),
  );

  fastify.post<{ Body: { networkId?: string; dotAmount: string; accountId: string; identityId?: string; evmAddress?: string } }>(
    "/get-vib/orders",
    {
      ...authPolicy("wallet-session", {
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
      }),
    },
    async (request) => {
      const session = await requirePolkadotWalletSession(fastify.coordinatorStore, request.headers as Record<string, string | string[] | undefined>);
      if (request.body.accountId !== session.address) {
        throw badRequest("Get VIB order accountId must match wallet session address", {
          accountId: request.body.accountId,
          sessionAddress: session.address,
        });
      }
      return ok({
        order: await createGetVibOrder({
          store: fastify.coordinatorStore,
          config: configForRequest(fastify.config, request, request.body.networkId),
          dotAmount: request.body.dotAmount,
          accountId: session.address,
          identityId: request.body.identityId,
          evmAddress: request.body.evmAddress,
        }),
      });
    },
  );

  fastify.get<{ Params: { orderId: string } }>(
    "/get-vib/orders/:orderId",
    {
      ...authPolicy("public-read", {
        tags: ["Get VIB"],
        summary: "Get a Get VIB DOT deposit order",
        params: { type: "object", required: ["orderId"], properties: { orderId: { type: "string" } } },
        response: { 200: envelopeKey("order") },
      }),
    },
    async (request) => ok({ order: await getOrder(fastify.coordinatorStore, request.params.orderId) }),
  );

  fastify.post<{ Body: { quoteId: string; paymentTxHash: string } }>(
    "/get-vib/curve/submit-payment",
    {
      ...authPolicy("wallet-session", {
        tags: ["Get VIB"],
        summary: "Bind a payment transaction hash to a Get VIB quote",
        body: {
          type: "object",
          required: ["quoteId", "paymentTxHash"],
          properties: {
            quoteId: { type: "string" },
            paymentTxHash: { type: "string" },
          },
        },
        response: { 200: envelopeKey("order") },
      }),
    },
    async (request) => {
      const session = await requirePolkadotWalletSession(fastify.coordinatorStore, request.headers as Record<string, string | string[] | undefined>);
      return ok({
        order: await submitGetVibPayment({
          store: fastify.coordinatorStore,
          quoteId: request.body.quoteId,
          paymentTxHash: request.body.paymentTxHash,
          accountId: session.address,
        }),
      });
    },
  );

  fastify.get<{ Params: { accountId: string } }>(
    "/get-vib/account/:accountId/summary",
    {
      ...authPolicy("public-read", {
        tags: ["Get VIB"],
        summary: "Get a user's Get VIB allocation summary",
        params: { type: "object", required: ["accountId"], properties: { accountId: { type: "string" } } },
        response: { 200: envelopeKey("summary") },
      }),
    },
    async (request) =>
      ok({ summary: await getAllocationSummary(fastify.coordinatorStore, configForRequest(fastify.config, request), request.params.accountId) }),
  );

  fastify.get<{ Params: { accountId: string } }>(
    "/get-vib/account/:accountId/proof",
    {
      ...authPolicy("public-read", {
        tags: ["Get VIB"],
        summary: "Get a user's current Get VIB Merkle claim proof",
        params: { type: "object", required: ["accountId"], properties: { accountId: { type: "string" } } },
        response: { 200: envelopeKey("proof") },
      }),
    },
    async (request) => ok({ proof: await getClaimProof(fastify.coordinatorStore, configForRequest(fastify.config, request), request.params.accountId) }),
  );

  fastify.get<{ Params: { accountId: string } }>(
    "/get-vib/account/:accountId/records",
    {
      ...authPolicy("public-read", {
        tags: ["Get VIB"],
        summary: "Get a user's Get VIB deposits, allocations, and claims",
        params: { type: "object", required: ["accountId"], properties: { accountId: { type: "string" } } },
        response: { 200: envelopeKey("records", recordsSchema) },
      }),
    },
    async (request) => ok({ records: await getRecords(fastify.coordinatorStore, configForRequest(fastify.config, request), request.params.accountId) }),
  );

  fastify.post<{ Body: { networkId?: string } }>(
    "/get-vib/claim-for",
    {
      ...authPolicy("wallet-session", {
        tags: ["Get VIB"],
        summary: "Sponsor a Get VIB claim with the configured claim-root publisher relayer",
        body: {
          type: "object",
          properties: {
            networkId: { type: "string" },
          },
        },
        response: { 200: envelopeKey("result") },
      }),
    },
    async (request) => {
      const session = await requirePolkadotWalletSession(fastify.coordinatorStore, request.headers as Record<string, string | string[] | undefined>);
      const requestConfig = configForRequest(fastify.config, request, request.body?.networkId);
      if (!requestConfig.getVibClaimEnabled) throw badRequest("Get VIB claim is not enabled");

      const [summary, proof] = await Promise.all([
        getAllocationSummary(fastify.coordinatorStore, requestConfig, session.address),
        getClaimProof(fastify.coordinatorStore, requestConfig, session.address),
      ]);
      if (BigInt(getVibAmountToBaseUnits(summary.claimableAmount)) <= 0n) {
        throw badRequest("No claimable Get VIB allocation is available");
      }
      if (proof.rootUploadStatus !== "uploaded") {
        throw badRequest("Get VIB claim root has not been uploaded yet", {
          rootVersion: proof.rootVersion,
          rootUploadStatus: proof.rootUploadStatus,
        });
      }

      const receipt = await new GetVibRootChainActions(requestConfig).claimFor(proof);
      const claim = receipt.finality === "prepared"
        ? undefined
        : await recordClaim({
          store: fastify.coordinatorStore,
          config: requestConfig,
          accountId: session.address,
          identityId: proof.identityId,
          rootVersion: proof.rootVersion,
          cumulativeAmount: proof.cumulativeAmount,
          claimedDelta: summary.claimableAmount,
          txHash: receipt.txHash,
          status: "confirmed",
        });
      return ok({ result: { receipt, claim } });
    },
  );

  fastify.get(
    "/get-vib/curve",
    {
      ...authPolicy("public-read", {
        tags: ["Get VIB"],
        summary: "Get Get VIB bonding curve display points",
        response: { 200: envelopeKey("curve") },
      }),
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
      ...authPolicy("coordinator-authority", {
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
      }),
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
      ...authPolicy("coordinator-authority", {
        tags: ["Admin", "Get VIB"],
        summary: "Get Get VIB relay deposit watcher status",
        response: { 200: envelopeKey("status") },
      }),
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


  fastify.get(
    "/admin/get-vib/root-uploader/status",
    {
      ...authPolicy("coordinator-authority", {
        tags: ["Admin", "Get VIB"],
        summary: "Get Get VIB root uploader status",
        response: { 200: envelopeKey("status") },
      }),
    },
    async () =>
      ok({
        status: await getGetVibRootUploaderStatus({
          config: fastify.config,
          store: fastify.coordinatorStore,
        }),
      }),
  );

  fastify.get<{ Querystring: { status?: "observed" | "confirmed" | "failed"; limit?: number } }>(
    "/admin/get-vib/relay-deposits",
    {
      ...authPolicy("coordinator-authority", {
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
      }),
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
      ...authPolicy("coordinator-authority", {
        tags: ["Admin", "Get VIB"],
        summary: "Build and persist the next cumulative Get VIB allocation manifest",
        response: { 200: envelopeKey("manifest") },
      }),
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
      ...authPolicy("coordinator-authority", {
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
      }),
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
