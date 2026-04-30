/**
 * Integration tests for governance routes.
 * Uses an in-memory SQLite database and a minimal Fastify instance.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { DatabaseSync } from "node:sqlite";
import { CoordinatorStore } from "../../db/coordinatorStore.js";
import { runMigrations } from "../../db/migrations.js";
import { GovernanceProjectorService } from "../../services/governanceProjector.js";
import { GovernanceIndexConsumer } from "../../services/governanceIndexConsumer.js";
import governanceRoutes from "./routes.js";
import type { NormalizedChainEvent } from "@concord/core";
import type { GovernanceEventType, GovernanceProposalSummary } from "@concord/governance";

const CHAIN = { namespace: "substrate", chainId: "vibly-solo" } as const;

function makeTestApp(store: CoordinatorStore) {
  const fastify = Fastify({ logger: false });

  // Minimal concord mock
  fastify.decorate("concord", {
    governanceIndexQuery: null,
    governanceGateway: {
      submitProposal: async () => ({ id: "mock", status: "submitted" }),
    },
    state: {
      events: { append: async () => {} },
    },
  } as unknown as Parameters<typeof fastify.decorate<"concord">>[1]);

  fastify.decorate("coordinatorStore", store);
  fastify.decorate("eventBus", { publish: () => {} } as unknown as Parameters<typeof fastify.decorate<"eventBus">>[1]);
  fastify.decorate("config", {
    substrateChainId: "vibly-solo",
    nodeEnv: "test",
  } as unknown as Parameters<typeof fastify.decorate<"config">>[1]);

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

function makeStore(): CoordinatorStore {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  return new CoordinatorStore(db);
}

function makeConsumer(store: CoordinatorStore): GovernanceIndexConsumer {
  const projector = new GovernanceProjectorService();
  const feed = { subscribeGovernanceEvents: async function* () {} } as Parameters<typeof GovernanceIndexConsumer>[0]["feed"];
  return new GovernanceIndexConsumer({ store, feed, chain: CHAIN, projector });
}

describe("governance routes", () => {
  let store: CoordinatorStore;
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
    consumer.handleEvent(store, event);

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
    consumer.handleEvent(store, event);
    consumer.handleEvent(store, event);

    const res = await app.inject({ method: "GET", url: "/governance/subjects" });
    const body = res.json<{ data: { items: unknown[] } }>();
    expect(body.data.items).toHaveLength(1);
  });

  it("GET /governance/subjects/:subjectId returns single subject", async () => {
    const event = makeProposalEvent("GovernanceProposalDiscovered", "42");
    consumer.handleEvent(store, event);
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
    consumer.handleEvent(store, subjectEvent);

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
    consumer.handleEvent(store, voteEvent);

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
    consumer.handleEvent(store, event);
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
    consumer.handleEvent(store, event);

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
    store.saveProjection("governance_checkpoint", staleCheckpoint.id, staleCheckpoint);

    const mergedRes = await app.inject({ method: "GET", url: "/governance/merged" });
    const body = mergedRes.json<{ data: { items: { id: string; freshness: { stale: boolean } }[] } }>();
    const entry = body.data.items.find((i) => i.id === `merged:${intentId}`);
    expect(entry).toBeDefined();
    expect(entry?.freshness.stale).toBe(true);
  });
});
