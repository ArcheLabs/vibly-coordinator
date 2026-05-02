/**
 * Integration tests for governance routes.
 * Uses an in-memory SQLite database and a minimal Fastify instance.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import { GovernanceProjectorService } from "../../services/governanceProjector.js";
import { GovernanceIndexConsumer } from "../../services/governanceIndexConsumer.js";
import { GovernanceBackendRegistry } from "../../services/governanceBackendRegistry.js";
import governanceRoutes from "./routes.js";
import type { NormalizedChainEvent } from "@concord/core";
import type {
  GovernanceCheckpointView,
  GovernanceEventType,
  GovernanceProposalSummary,
  GovernanceIndexFeedPort,
} from "@concord/governance";

const CHAIN = { namespace: "substrate", chainId: "vibly-solo" } as const;
const EVM_CHAIN = { namespace: "eip155", chainId: "31337" } as const;

function makeEvmProposalEvent(externalId: string, status = "Deciding"): NormalizedChainEvent<GovernanceEventType> {
  const payload: GovernanceProposalSummary = {
    ref: { chain: EVM_CHAIN, backend: "evm-governor", externalId },
    title: `EVM Proposal ${externalId}`,
    status,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T01:00:00Z",
  };
  return {
    id: `evt:evm:${externalId}:GovernanceProposalDiscovered`,
    chain: EVM_CHAIN,
    type: "GovernanceProposalDiscovered",
    payload,
    blockNumber: 200n,
    blockHash: "0xdef",
    observedAt: "2026-01-01T01:00:00Z",
    finality: "finalized",
  };
}

function makeTestApp(store: CoordinatorStorePort, config?: Partial<import("../../config/env.js").CoordinatorConfig>) {
  const fastify = Fastify({ logger: false });

  // Minimal concord mock
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fastify.decorate("concord", {
    governanceIndexQuery: null,
    governanceGateway: {
      submitProposal: async () => ({ id: "mock", status: "submitted" }),
    },
    state: {
      events: { append: async () => {} },
    },
  } as unknown as import("@concord/sdk").Concord);

  fastify.decorate("coordinatorStore", store);
  fastify.decorate("eventBus", { publish: () => {} } as unknown as import("../../services/eventBus.js").EventBus);
  fastify.decorate("config", {
    substrateChainId: "vibly-solo",
    substrateRpcUrl: "ws://127.0.0.1:9944",
    substrateGovernanceTxMode: "prepare-only",
    evmChainId: "31337",
    enableDevRoutes: false,
    nodeEnv: "test",
    ...config,
  } as unknown as import("../../config/env.js").CoordinatorConfig);

  fastify.decorate("governanceBackendRegistry", new GovernanceBackendRegistry());

  void fastify.register(governanceRoutes);
  return fastify;
}

function makeProposalEvent(
  type: GovernanceEventType,
  externalId: string,
  status = "Deciding",
): NormalizedChainEvent<GovernanceEventType> {
  const payload: GovernanceProposalSummary = {
    ref: { chain: CHAIN, backend: "substrate-opengov", externalId },
    title: `Proposal ${externalId}`,
    status,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T01:00:00Z",
  };
  return {
    id: `evt:${externalId}:${type}`,
    chain: CHAIN,
    type,
    payload,
    blockNumber: 100n,
    blockHash: "0xabc",
    observedAt: "2026-01-01T01:00:00Z",
    finality: "finalized",
  };
}

function makeStore(): CoordinatorStorePort {
  const projections = new Map<string, Map<string, unknown>>();
  return {
    async saveProjection(kind: string, id: string, value: unknown) {
      const bucket = projections.get(kind) ?? new Map<string, unknown>();
      bucket.set(id, value);
      projections.set(kind, bucket);
    },
    async getProjection(_kind: string, id: string) {
      return (projections.get(_kind)?.get(id) ?? undefined) as never;
    },
    async listProjections(kind: string) {
      return Array.from(projections.get(kind)?.values() ?? []) as never;
    },
    async deleteProjection(kind: string, id: string) {
      projections.get(kind)?.delete(id);
    },
    async createLease() {
      throw new Error("not implemented");
    },
    async getLease() {
      return undefined;
    },
    async getActiveLease() {
      return undefined;
    },
    async renewLease() {
      return undefined;
    },
    async releaseLease() {},
    async sweepExpiredLeases() {
      return [];
    },
  };
}

function makeConsumer(store: CoordinatorStorePort): GovernanceIndexConsumer {
  const projector = new GovernanceProjectorService();
  const feed = { subscribeGovernanceEvents: async function* () {} } as GovernanceIndexFeedPort;
  return new GovernanceIndexConsumer({ store, feed, chain: CHAIN, projector });
}

function makeEvmConsumer(store: CoordinatorStorePort): GovernanceIndexConsumer {
  const projector = new GovernanceProjectorService();
  const feed = { subscribeGovernanceEvents: async function* () {} } as GovernanceIndexFeedPort;
  return new GovernanceIndexConsumer({ store, feed, chain: EVM_CHAIN, projector });
}

describe("governance routes", () => {
  let store: CoordinatorStorePort;
  let app: ReturnType<typeof makeTestApp>;
  let consumer: GovernanceIndexConsumer;

  beforeEach(async () => {
    store = makeStore();
    app = makeTestApp(store);
    consumer = makeConsumer(store);
    await app.ready();
  });

  // ── Subject events → GET /governance/subjects ────────────────────────────

  it("GET /governance/subjects returns empty when no subjects indexed", async () => {
    const res = await app.inject({ method: "GET", url: "/governance/subjects" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { items: unknown[] } }>();
    expect(body.data.items).toHaveLength(0);
  });

  it("Subject event → GET /governance/subjects returns GovernanceSubjectView", async () => {
    const event = makeProposalEvent("GovernanceProposalDiscovered", "42");
    await consumer.handleEvent(store, event);

    const res = await app.inject({ method: "GET", url: "/governance/subjects" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { items: { externalId: string; status: string; backend: string }[] } }>();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].externalId).toBe("42");
    expect(body.data.items[0].status).toBe("Deciding");
    expect(body.data.items[0].backend).toBe("substrate-opengov");
  });

  it("replaying same event → only one subject in /governance/subjects (idempotent)", async () => {
    const event = makeProposalEvent("GovernanceProposalDiscovered", "42");
    await consumer.handleEvent(store, event);
    await consumer.handleEvent(store, event);

    const res = await app.inject({ method: "GET", url: "/governance/subjects" });
    const body = res.json<{ data: { items: unknown[] } }>();
    expect(body.data.items).toHaveLength(1);
  });

  it("GET /governance/subjects/:subjectId returns single subject", async () => {
    const event = makeProposalEvent("GovernanceProposalDiscovered", "42");
    await consumer.handleEvent(store, event);
    const subjectId = "substrate:vibly-solo:42";

    const res = await app.inject({ method: "GET", url: `/governance/subjects/${encodeURIComponent(subjectId)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { subject: { id: string } } }>();
    expect(body.data.subject.id).toBe(subjectId);
  });

  it("GET /governance/subjects/:subjectId returns 404 for unknown subject", async () => {
    const res = await app.inject({ method: "GET", url: "/governance/subjects/unknown:id" });
    expect(res.statusCode).toBe(404);
  });

  // ── Votes → GET /governance/subjects/:subjectId/votes ─────────────────────

  it("Subject and vote events → GET /governance/subjects/:subjectId/votes", async () => {
    const subjectEvent = makeProposalEvent("GovernanceProposalDiscovered", "42");
    await consumer.handleEvent(store, subjectEvent);

    const votePayload = {
      ref: { chain: CHAIN, backend: "substrate-opengov" as const, externalId: "42" },
      status: "Deciding",
      voter: "0xVoter1",
      stance: "aye",
      conviction: "Locked1x",
      balance: "100000000",
    };
    const voteEvent: NormalizedChainEvent<GovernanceEventType> = {
      id: "evt:vote:42:0xVoter1",
      chain: CHAIN,
      type: "GovernanceVoteCast",
      payload: votePayload,
      blockNumber: 101n,
      observedAt: "2026-01-01T02:00:00Z",
      finality: "finalized",
    };
    await consumer.handleEvent(store, voteEvent);

    const subjectId = encodeURIComponent("substrate:vibly-solo:42");
    const res = await app.inject({ method: "GET", url: `/governance/subjects/${subjectId}/votes` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { items: { voter: string; stance: string }[] } }>();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].voter).toBe("0xVoter1");
    expect(body.data.items[0].stance).toBe("aye");
  });

  // ── Intent + merged ────────────────────────────────────────────────────────

  it("POST intent → GET /governance/merged returns not_submitted entry", async () => {
    const postRes = await app.inject({
      method: "POST",
      url: "/governance/intents",
      payload: { kind: "governance", title: "Test Proposal", projectId: "proj-1" },
    });
    expect(postRes.statusCode).toBe(200);
    const intentId = postRes.json<{ data: { governanceIntent: { id: string } } }>().data.governanceIntent.id;

    const mergedRes = await app.inject({ method: "GET", url: "/governance/merged?projectId=proj-1" });
    expect(mergedRes.statusCode).toBe(200);
    const body = mergedRes.json<{ data: { items: { id: string; status: { merged: string } }[] } }>();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].status.merged).toBe("not_submitted");
    expect(body.data.items[0].id).toBe(`merged:${intentId}`);
  });

  it("POST link-subject → GET /governance/merged/:id returns link + merged status", async () => {
    // Create intent
    const intentRes = await app.inject({
      method: "POST",
      url: "/governance/intents",
      payload: { kind: "governance", title: "Linked Proposal" },
    });
    const intentId = intentRes.json<{ data: { governanceIntent: { id: string } } }>().data.governanceIntent.id;

    // Feed subject event to create a GovernanceSubjectView
    const event = makeProposalEvent("GovernanceProposalDiscovered", "99", "Deciding");
    await consumer.handleEvent(store, event);
    const subjectId = "substrate:vibly-solo:99";

    // Link intent to subject
    const linkRes = await app.inject({
      method: "POST",
      url: `/governance/intents/${intentId}/link-subject`,
      payload: { subjectId, externalId: "99", linkSource: "explicit", confidence: "high" },
    });
    expect(linkRes.statusCode).toBe(200);

    // Get merged view
    const mergedRes = await app.inject({ method: "GET", url: `/governance/merged/merged:${intentId}` });
    expect(mergedRes.statusCode).toBe(200);
    const body = mergedRes.json<{ data: { merged: { status: { merged: string }; link: { subjectId: string } } } }>();
    expect(body.data.merged.status.merged).toBe("active_on_chain");
    expect(body.data.merged.link?.subjectId).toBe(subjectId);
  });

  it("POST /governance/intents/:id/submit-opengov records receipt and optional pending link", async () => {
    const localApp = makeTestApp(store, {
      substrateChainId: "substrate:vibly-solo",
      substrateGovernanceTxMode: "fixture",
    });
    await localApp.ready();
    const intentRes = await localApp.inject({
      method: "POST",
      url: "/governance/intents",
      payload: { kind: "governance", title: "Submit OpenGov" },
    });
    const intentId = intentRes.json<{ data: { governanceIntent: { id: string } } }>().data.governanceIntent.id;

    const submitRes = await localApp.inject({
      method: "POST",
      url: `/governance/intents/${intentId}/submit-opengov`,
      payload: {
        actor: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        externalId: "123",
        submitArgs: { proposal: "0xproposal", enactment: "After" },
      },
    });

    expect(submitRes.statusCode).toBe(200);
    const submitBody = submitRes.json<{
      data: {
        governanceIntent: { status: string; readbackStatus: string };
        receipt: { tx: { txHash: string }; readbackStatus: string };
        link: { externalId: string; linkSource: string };
      };
    }>();
    expect(submitBody.data.governanceIntent.status).toBe("submitted");
    expect(submitBody.data.receipt.tx.txHash).toMatch(/^0xphasee_submit_/);
    expect(submitBody.data.receipt.readbackStatus).toBe("linked");
    expect(submitBody.data.link).toMatchObject({ externalId: "123", linkSource: "tx_receipt" });

    const mergedRes = await localApp.inject({ method: "GET", url: `/governance/merged/merged:${intentId}` });
    const mergedBody = mergedRes.json<{ data: { merged: { actionReceipts: unknown[]; readbackStatus: string; readback: { pending: boolean; submitTxHash?: string } } } }>();
    expect(mergedBody.data.merged.actionReceipts).toHaveLength(1);
    expect(mergedBody.data.merged.readbackStatus).toBe("linked");
    expect(mergedBody.data.merged.readback.pending).toBe(false);
    expect(mergedBody.data.merged.readback.submitTxHash).toMatch(/^0xphasee_submit_/);

    await localApp.close();
  });

  it("POST /governance/intents/:id/reconcile-subject links indexed subject and receipt", async () => {
    const localApp = makeTestApp(store, {
      substrateChainId: "substrate:vibly-solo",
      substrateGovernanceTxMode: "fixture",
    });
    await localApp.ready();
    const intentRes = await localApp.inject({
      method: "POST",
      url: "/governance/intents",
      payload: { kind: "governance", title: "Reconcile OpenGov" },
    });
    const intentId = intentRes.json<{ data: { governanceIntent: { id: string } } }>().data.governanceIntent.id;
    await localApp.inject({
      method: "POST",
      url: `/governance/intents/${intentId}/submit-opengov`,
      payload: {
        actor: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        submitArgs: { proposal: "0xproposal", enactment: "After" },
      },
    });
    await consumer.handleEvent(store, makeProposalEvent("GovernanceProposalDiscovered", "77"));

    const reconcileRes = await localApp.inject({
      method: "POST",
      url: `/governance/intents/${intentId}/reconcile-subject`,
      payload: { externalId: "77" },
    });

    expect(reconcileRes.statusCode).toBe(200);
    const reconcileBody = reconcileRes.json<{
      data: { governanceIntent: { readbackStatus: string; status: string }; link: { subjectId: string }; receipts: number };
    }>();
    expect(reconcileBody.data.governanceIntent.readbackStatus).toBe("linked");
    expect(reconcileBody.data.governanceIntent.status).toBe("Deciding");
    expect(reconcileBody.data.link.subjectId).toBe("substrate:vibly-solo:77");
    expect(reconcileBody.data.receipts).toBe(1);

    const mergedRes = await localApp.inject({ method: "GET", url: `/governance/merged/merged:${intentId}` });
    const mergedBody = mergedRes.json<{ data: { merged: { subject?: { externalId: string }; readbackStatus: string; readback: { linked: boolean } } } }>();
    expect(mergedBody.data.merged.subject?.externalId).toBe("77");
    expect(mergedBody.data.merged.readbackStatus).toBe("linked");
    expect(mergedBody.data.merged.readback.linked).toBe(true);

    await localApp.close();
  });

  it("POST /governance/subjects/:id/vote-opengov records a pending vote receipt", async () => {
    const localApp = makeTestApp(store, { substrateGovernanceTxMode: "fixture" });
    await localApp.ready();
    await consumer.handleEvent(store, makeProposalEvent("GovernanceProposalDiscovered", "42"));
    const subjectId = encodeURIComponent("substrate:vibly-solo:42");

    const voteRes = await localApp.inject({
      method: "POST",
      url: `/governance/subjects/${subjectId}/vote-opengov`,
      payload: {
        voter: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        stance: "aye",
        weight: "2000000000",
        conviction: 1,
      },
    });

    expect(voteRes.statusCode).toBe(200);
    const body = voteRes.json<{ data: { receipt: { tx: { txHash: string }; readbackStatus: string } } }>();
    expect(body.data.receipt.tx.txHash).toMatch(/^0xphasee_vote_/);
    expect(body.data.receipt.readbackStatus).toBe("pending_indexer");

    const mergedRes = await localApp.inject({ method: "GET", url: `/governance/merged/${subjectId}` });
    const mergedBody = mergedRes.json<{ data: { merged: { readback: { voteReadbackStatus: string; voteReceiptCount: number } } } }>();
    expect(mergedBody.data.merged.readback.voteReadbackStatus).toBe("pending_indexer");
    expect(mergedBody.data.merged.readback.voteReceiptCount).toBe(1);

    await localApp.close();
  });

  it("GET /governance/merged/:id returns 404 for unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/governance/merged/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ── Delegations ────────────────────────────────────────────────────────────

  it("Delegation event → GET /governance/delegations returns DelegationView", async () => {
    const payload = {
      ref: { chain: CHAIN, backend: "substrate-opengov" as const, externalId: "0xDelegator" },
      status: "active",
      delegatee: "0xDelegatee",
      scope: "class:10",
    };
    const event: NormalizedChainEvent<GovernanceEventType> = {
      id: "evt:delegation",
      chain: CHAIN,
      type: "GovernanceDelegated",
      payload,
      blockNumber: 200n,
      observedAt: "2026-01-02T00:00:00Z",
      finality: "finalized",
    };
    await consumer.handleEvent(store, event);

    const res = await app.inject({ method: "GET", url: "/governance/delegations" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { items: { isActive: boolean; delegatee: string }[] } }>();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].isActive).toBe(true);
    expect(body.data.items[0].delegatee).toBe("0xDelegatee");
  });

  // ── Stale checkpoint ──────────────────────────────────────────────────────

  it("Stale checkpoint → merged view freshness.stale=true", async () => {
    // Create intent
    const intentRes = await app.inject({
      method: "POST",
      url: "/governance/intents",
      payload: { kind: "governance", title: "Stale Test" },
    });
    const intentId = intentRes.json<{ data: { governanceIntent: { id: string } } }>().data.governanceIntent.id;

    // Manually write a stale checkpoint (1 hour ago)
    const staleCheckpoint = {
      id: "checkpoint:substrate:vibly-solo",
      chain: CHAIN,
      finalized: true,
      observedAt: new Date(Date.now() - 3_600_000).toISOString(), // 1 hour ago
      source: { adapter: "subquery" },
      projection: { version: "1", hash: "h1", projectedAt: new Date().toISOString(), projector: "test" },
    };
    await store.saveProjection("governance_checkpoint", staleCheckpoint.id, staleCheckpoint);

    const mergedRes = await app.inject({ method: "GET", url: "/governance/merged" });
    const body = mergedRes.json<{ data: { items: { id: string; freshness: { stale: boolean } }[] } }>();
    const entry = body.data.items.find((i) => i.id === `merged:${intentId}`);
    expect(entry).toBeDefined();
    expect(entry?.freshness.stale).toBe(true);
  });

  it("GET /governance/merged uses the checkpoint for each subject chain", async () => {
    const evmConsumer = makeEvmConsumer(store);
    await consumer.handleEvent(store, makeProposalEvent("GovernanceProposalDiscovered", "sub-stale"));
    await evmConsumer.handleEvent(store, makeEvmProposalEvent("evm-fresh"));

    const staleSubstrateCheckpoint: GovernanceCheckpointView = {
      id: "checkpoint:substrate:vibly-solo",
      chain: CHAIN,
      finalized: true,
      observedAt: new Date(Date.now() - 3_600_000).toISOString(),
      source: { adapter: "subquery" },
      projection: { version: "1", hash: "substrate-old", projectedAt: new Date().toISOString(), projector: "test" },
    };
    const freshEvmCheckpoint: GovernanceCheckpointView = {
      id: "checkpoint:eip155:31337",
      chain: EVM_CHAIN,
      finalized: false,
      observedAt: new Date().toISOString(),
      source: { adapter: "evm-fixture" },
      projection: { version: "1", hash: "evm-new", projectedAt: new Date().toISOString(), projector: "test" },
    };
    await store.saveProjection("governance_checkpoint", staleSubstrateCheckpoint.id, staleSubstrateCheckpoint);
    await store.saveProjection("governance_checkpoint", freshEvmCheckpoint.id, freshEvmCheckpoint);

    const res = await app.inject({ method: "GET", url: "/governance/merged" });
    const body = res.json<{
      data: {
        items: {
          subject?: { backend: string };
          freshness: { stale: boolean; checkpoint?: { id: string } };
        }[];
      };
    }>();

    const substrateEntry = body.data.items.find((item) => item.subject?.backend === "substrate-opengov");
    const evmEntry = body.data.items.find((item) => item.subject?.backend === "evm-governor");
    expect(substrateEntry?.freshness.checkpoint?.id).toBe("checkpoint:substrate:vibly-solo");
    expect(substrateEntry?.freshness.stale).toBe(true);
    expect(evmEntry?.freshness.checkpoint?.id).toBe("checkpoint:eip155:31337");
    expect(evmEntry?.freshness.stale).toBe(false);
  });

  it("GET /governance/checkpoint can filter stored checkpoints by backend", async () => {
    app.governanceBackendRegistry.register(
      {
        id: "evm-fixture",
        backend: "evm-governor",
        chain: EVM_CHAIN,
        displayName: "EVM Governor fixture",
        source: { kind: "fixture" },
        capabilities: {
          readSubjects: true, readVotes: true, readDelegations: false, checkpoint: true,
          prepareProposal: true, submitProposal: true, castVote: true, delegate: false,
          queueExecution: true, executeProposal: true, requiresWallet: true,
          supportsReason: true, supportsWeightedVote: false,
        },
      },
      { start: () => {} } as unknown as GovernanceIndexConsumer,
    );
    const evmCheckpoint: GovernanceCheckpointView = {
      id: "checkpoint:eip155:31337",
      chain: EVM_CHAIN,
      finalized: false,
      observedAt: new Date().toISOString(),
      source: { adapter: "evm-fixture" },
      projection: { version: "1", hash: "evm-checkpoint", projectedAt: new Date().toISOString(), projector: "test" },
    };
    await store.saveProjection("governance_checkpoint", evmCheckpoint.id, evmCheckpoint);

    const res = await app.inject({ method: "GET", url: "/governance/checkpoint?backend=evm-governor" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { checkpoint: { id: string } | null; items: { id: string }[] } }>();
    expect(body.data.checkpoint?.id).toBe("checkpoint:eip155:31337");
    expect(body.data.items).toHaveLength(1);
  });

  // ── D5: backend filter + /governance/backends ──────────────────────────────

  it("GET /governance/subjects?backend= filters by backend", async () => {
    const evmConsumer = makeEvmConsumer(store);
    await consumer.handleEvent(store, makeProposalEvent("GovernanceProposalDiscovered", "sub-1"));
    await evmConsumer.handleEvent(store, makeEvmProposalEvent("evm-1"));

    const subRes = await app.inject({ method: "GET", url: "/governance/subjects?backend=substrate-opengov" });
    const subBody = subRes.json<{ data: { items: { backend: string }[] } }>();
    expect(subBody.data.items).toHaveLength(1);
    expect(subBody.data.items[0].backend).toBe("substrate-opengov");

    const evmRes = await app.inject({ method: "GET", url: "/governance/subjects?backend=evm-governor" });
    const evmBody = evmRes.json<{ data: { items: { backend: string }[] } }>();
    expect(evmBody.data.items).toHaveLength(1);
    expect(evmBody.data.items[0].backend).toBe("evm-governor");

    const allRes = await app.inject({ method: "GET", url: "/governance/subjects" });
    const allBody = allRes.json<{ data: { items: unknown[] } }>();
    expect(allBody.data.items).toHaveLength(2);
  });

  it("GET /governance/merged?backend= filters by subject backend", async () => {
    const evmConsumer = makeEvmConsumer(store);
    await consumer.handleEvent(store, makeProposalEvent("GovernanceProposalDiscovered", "sub-2"));
    await evmConsumer.handleEvent(store, makeEvmProposalEvent("evm-2"));

    const evmRes = await app.inject({ method: "GET", url: "/governance/merged?backend=evm-governor" });
    const evmBody = evmRes.json<{ data: { items: { subject?: { backend: string } }[] } }>();
    expect(evmBody.data.items).toHaveLength(1);
    expect(evmBody.data.items[0].subject?.backend).toBe("evm-governor");

    const allRes = await app.inject({ method: "GET", url: "/governance/merged" });
    const allBody = allRes.json<{ data: { items: unknown[] } }>();
    expect(allBody.data.items).toHaveLength(2);
  });

  it("GET /governance/backends returns empty array when no backends registered", async () => {
    const res = await app.inject({ method: "GET", url: "/governance/backends" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { backends: unknown[] } }>();
    expect(body.data.backends).toHaveLength(0);
  });

  it("GET /governance/backends returns registered descriptors", async () => {
    const { GovernanceBackendRegistry: Registry } = await import("../../services/governanceBackendRegistry.js");
    const registry = new Registry();
    registry.register(
      {
        id: "substrate-local",
        backend: "substrate-opengov",
        chain: CHAIN,
        displayName: "Vibly Solo",
        source: { kind: "subquery" },
        capabilities: {
          readSubjects: true, readVotes: true, readDelegations: true, checkpoint: true,
          prepareProposal: true, submitProposal: true, castVote: true, delegate: true,
          queueExecution: false, executeProposal: false, requiresWallet: false,
          supportsReason: true, supportsWeightedVote: true,
        },
      },
      { start: () => {} } as unknown as import("../../services/governanceIndexConsumer.js").GovernanceIndexConsumer,
    );

    const localApp = Fastify({ logger: false });
    localApp.decorate("concord", app.concord);
    localApp.decorate("coordinatorStore", store);
    localApp.decorate("eventBus", { publish: () => {} } as unknown as import("../../services/eventBus.js").EventBus);
    localApp.decorate("config", { substrateChainId: "vibly-solo", nodeEnv: "test" } as unknown as import("../../config/env.js").CoordinatorConfig);
    localApp.decorate("governanceBackendRegistry", registry);
    void localApp.register(governanceRoutes);
    await localApp.ready();

    const res = await localApp.inject({ method: "GET", url: "/governance/backends" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { backends: { id: string; backend: string }[] } }>();
    expect(body.data.backends).toHaveLength(1);
    expect(body.data.backends[0].id).toBe("substrate-local");
    expect(body.data.backends[0].backend).toBe("substrate-opengov");

    await localApp.close();
  });

  it("GET /governance/backends includes unavailable health when no checkpoint exists", async () => {
    app.governanceBackendRegistry.register(
      {
        id: "substrate-local",
        backend: "substrate-opengov",
        chain: CHAIN,
        displayName: "Vibly Solo",
        source: { kind: "subquery" },
        capabilities: {
          readSubjects: true, readVotes: true, readDelegations: true, checkpoint: true,
          prepareProposal: true, submitProposal: true, castVote: true, delegate: true,
          queueExecution: false, executeProposal: false, requiresWallet: false,
          supportsReason: true, supportsWeightedVote: true,
        },
      },
      { start: () => {} } as unknown as GovernanceIndexConsumer,
    );

    const res = await app.inject({ method: "GET", url: "/governance/backends" });
    const body = res.json<{
      data: { backends: { id: string; health: { status: string; stale: boolean; reason?: string } }[] };
    }>();

    expect(body.data.backends[0]).toMatchObject({
      id: "substrate-local",
      health: { status: "unavailable", stale: true, reason: "checkpoint_missing" },
    });
  });

  it("GET /governance/backends reports freshness per backend chain", async () => {
    app.governanceBackendRegistry.register(
      {
        id: "substrate-local",
        backend: "substrate-opengov",
        chain: CHAIN,
        displayName: "Vibly Solo",
        source: { kind: "subquery" },
        capabilities: {
          readSubjects: true, readVotes: true, readDelegations: true, checkpoint: true,
          prepareProposal: true, submitProposal: true, castVote: true, delegate: true,
          queueExecution: false, executeProposal: false, requiresWallet: false,
          supportsReason: true, supportsWeightedVote: true,
        },
      },
      { start: () => {} } as unknown as GovernanceIndexConsumer,
    );
    app.governanceBackendRegistry.register(
      {
        id: "evm-fixture",
        backend: "evm-governor",
        chain: EVM_CHAIN,
        displayName: "EVM Governor fixture",
        source: { kind: "fixture" },
        capabilities: {
          readSubjects: true, readVotes: true, readDelegations: false, checkpoint: true,
          prepareProposal: true, submitProposal: true, castVote: true, delegate: false,
          queueExecution: true, executeProposal: true, requiresWallet: true,
          supportsReason: true, supportsWeightedVote: false,
        },
      },
      { start: () => {} } as unknown as GovernanceIndexConsumer,
    );

    await store.saveProjection("governance_checkpoint", "checkpoint:substrate:vibly-solo", {
      id: "checkpoint:substrate:vibly-solo",
      chain: CHAIN,
      finalized: true,
      observedAt: new Date(Date.now() - 3_600_000).toISOString(),
      source: { adapter: "subquery" },
      projection: { version: "1", hash: "substrate-old", projectedAt: new Date().toISOString(), projector: "test" },
    } satisfies GovernanceCheckpointView);
    await store.saveProjection("governance_checkpoint", "checkpoint:eip155:31337", {
      id: "checkpoint:eip155:31337",
      chain: EVM_CHAIN,
      finalized: false,
      observedAt: new Date().toISOString(),
      source: { adapter: "evm-fixture" },
      projection: { version: "1", hash: "evm-new", projectedAt: new Date().toISOString(), projector: "test" },
    } satisfies GovernanceCheckpointView);

    const res = await app.inject({ method: "GET", url: "/governance/backends" });
    const body = res.json<{
      data: { backends: { id: string; health: { status: string; stale: boolean; checkpoint?: { id: string } } }[] };
    }>();

    const substrate = body.data.backends.find((backend) => backend.id === "substrate-local");
    const evm = body.data.backends.find((backend) => backend.id === "evm-fixture");
    expect(substrate?.health).toMatchObject({
      status: "stale",
      stale: true,
      checkpoint: { id: "checkpoint:substrate:vibly-solo" },
    });
    expect(evm?.health).toMatchObject({
      status: "healthy",
      stale: false,
      checkpoint: { id: "checkpoint:eip155:31337" },
    });
  });

  it("GET /governance/backends omits EVM when the fixture backend is disabled", async () => {
    app.governanceBackendRegistry.register(
      {
        id: "substrate-local",
        backend: "substrate-opengov",
        chain: CHAIN,
        displayName: "Vibly Solo",
        source: { kind: "subquery" },
        capabilities: {
          readSubjects: true, readVotes: true, readDelegations: true, checkpoint: true,
          prepareProposal: true, submitProposal: true, castVote: true, delegate: true,
          queueExecution: false, executeProposal: false, requiresWallet: false,
          supportsReason: true, supportsWeightedVote: true,
        },
      },
      { start: () => {} } as unknown as GovernanceIndexConsumer,
    );

    const res = await app.inject({ method: "GET", url: "/governance/backends" });
    const body = res.json<{ data: { backends: { backend: string }[] } }>();

    expect(body.data.backends.map((backend) => backend.backend)).toEqual(["substrate-opengov"]);
  });

  it("POST /governance/dev/seed-demo seeds Substrate and EVM merged demo subjects when dev routes are enabled", async () => {
    const localApp = makeTestApp(store, {
      enableDevRoutes: true,
      substrateChainId: "substrate:vibly-solo",
      evmChainId: "31337",
    });
    await localApp.ready();

    const seedRes = await localApp.inject({ method: "POST", url: "/governance/dev/seed-demo" });
    expect(seedRes.statusCode).toBe(200);

    const mergedRes = await localApp.inject({ method: "GET", url: "/governance/merged" });
    const body = mergedRes.json<{ data: { items: { subject?: { backend: string } }[] } }>();
    expect(body.data.items.some((item) => item.subject?.backend === "substrate-opengov")).toBe(true);
    expect(body.data.items.some((item) => item.subject?.backend === "evm-governor")).toBe(true);

    await localApp.close();
  });
});
