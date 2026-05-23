/**
 * Public Library API route tests.
 *
 * Uses an in-memory store seeded with fixture data to validate:
 * - All query parameters on GET /api/public/artifacts
 * - Slug lookup and 404 on GET /api/public/artifacts/:slug
 * - popular ordering on GET /api/public/artifacts/popular
 * - org/project/agent list + detail endpoints
 * - response schema coverage (all routes return ok: true)
 */

import { describe, expect, it, beforeEach } from "vitest";
import Fastify from "fastify";
import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import { authPolicy } from "../../plugins/authPolicy.js";
import publicLibraryRoutes from "./publicLibrary.js";
import type { PublicArtifact, PublicOrganization, PublicProject, PublicAgent } from "../../contexts/library/types.js";
import { KIND_ARTIFACT, KIND_ORG, KIND_PROJECT, KIND_AGENT } from "../../contexts/library/repository.js";

// ─── In-memory store ─────────────────────────────────────────────────────────

function makeStore(): CoordinatorStorePort {
  const projections = new Map<string, Map<string, unknown>>();
  return {
    async saveProjection(kind: string, id: string, value: unknown) {
      const bucket = projections.get(kind) ?? new Map<string, unknown>();
      bucket.set(id, value);
      projections.set(kind, bucket);
    },
    async getProjection(kind: string, id: string) {
      return (projections.get(kind)?.get(id) ?? undefined) as never;
    },
    async listProjections(kind: string) {
      return Array.from(projections.get(kind)?.values() ?? []) as never;
    },
    async deleteProjection(kind: string, id: string) {
      projections.get(kind)?.delete(id);
    },
    async createLease() { throw new Error("not implemented"); },
    async tryAcquireLease() { throw new Error("not implemented"); },
    async getLease() { return undefined; },
    async getActiveLease() { return undefined; },
    async renewLease() { return undefined; },
    async releaseLease() {},
    async sweepExpiredLeases() { return []; },
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeArtifact(overrides: Partial<PublicArtifact> = {}): PublicArtifact {
  return {
    id: "art-1",
    title: "Open Intelligence Model",
    slug: "open-intelligence-model",
    summary: "A summary",
    markdown: "# Content",
    orgId: "org-1",
    orgSlug: "vibly",
    orgName: "Vibly",
    type: "report",
    status: "published",
    order: 1,
    tags: ["ai"],
    authorAgentId: "agent-1",
    authorAgentName: "Alice",
    contributors: [],
    reviewCount: 2,
    hotScore: 50,
    version: 1,
    sourceReviewRoundIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    publishedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeOrg(overrides: Partial<PublicOrganization> = {}): PublicOrganization {
  return { id: "org-1", slug: "vibly", name: "Vibly", description: "Vibly org", documentCount: 5, agentCount: 3, projectCount: 2, ...overrides };
}

function makeProject(overrides: Partial<PublicProject> = {}): PublicProject {
  return { id: "proj-1", slug: "protocol-design", name: "Protocol Design", description: "Core protocol", orgId: "org-1", orgSlug: "vibly", orgName: "Vibly", documentCount: 5, agentCount: 3, ...overrides };
}

function makeAgent(overrides: Partial<PublicAgent> = {}): PublicAgent {
  return { id: "agent-1", name: "Alice", reputation: 80, documentCount: 3, ...overrides };
}

// ─── App factory ──────────────────────────────────────────────────────────────

async function buildApp(store: CoordinatorStorePort) {
  const fastify = Fastify({ logger: false });
  fastify.decorate("coordinatorStore", store);
  // Minimal auth plugin shim: authPolicy("public-read") just returns security:[]
  fastify.decorateRequest("principal", null);
  fastify.addHook("preHandler", async () => {});
  await fastify.register(publicLibraryRoutes);
  await fastify.ready();
  return fastify;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/public/artifacts", () => {
  it("returns empty list when no data", async () => {
    const app = await buildApp(makeStore());
    const res = await app.inject({ method: "GET", url: "/api/public/artifacts" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  it("filters by type", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ARTIFACT, "art-1", makeArtifact({ type: "report" }));
    await store.saveProjection(KIND_ARTIFACT, "art-2", makeArtifact({ id: "art-2", slug: "spec-doc", type: "spec" }));
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/artifacts?type=report" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].type).toBe("report");
  });

  it("filters by status", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ARTIFACT, "art-1", makeArtifact({ status: "published" }));
    await store.saveProjection(KIND_ARTIFACT, "art-2", makeArtifact({ id: "art-2", slug: "art-2", status: "verified" }));
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/artifacts?status=verified" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].status).toBe("verified");
  });

  it("filters by org slug", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ARTIFACT, "art-1", makeArtifact({ orgSlug: "vibly" }));
    await store.saveProjection(KIND_ARTIFACT, "art-2", makeArtifact({ id: "art-2", slug: "art-2", orgSlug: "vibmath" }));
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/artifacts?org=vibly" });
    const body = res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].orgSlug).toBe("vibly");
  });

  it("filters by project slug", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ARTIFACT, "art-1", makeArtifact({ projectSlug: "protocol-design" }));
    await store.saveProjection(KIND_ARTIFACT, "art-2", makeArtifact({ id: "art-2", slug: "art-2", projectSlug: "reputation" }));
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/artifacts?project=protocol-design" });
    const body = res.json();
    expect(body.data.items).toHaveLength(1);
  });

  it("filters by agent id", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ARTIFACT, "art-1", makeArtifact({ authorAgentId: "agent-1" }));
    await store.saveProjection(KIND_ARTIFACT, "art-2", makeArtifact({ id: "art-2", slug: "art-2", authorAgentId: "agent-2" }));
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/artifacts?agent=agent-1" });
    const body = res.json();
    expect(body.data.items).toHaveLength(1);
  });

  it("filters by q (full-text)", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ARTIFACT, "art-1", makeArtifact({ title: "Goldbach Conjecture" }));
    await store.saveProjection(KIND_ARTIFACT, "art-2", makeArtifact({ id: "art-2", slug: "art-2", title: "Protocol Design" }));
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/artifacts?q=goldbach" });
    const body = res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].title).toBe("Goldbach Conjecture");
  });

  it("respects limit and offset", async () => {
    const store = makeStore();
    for (let i = 1; i <= 5; i++) {
      await store.saveProjection(KIND_ARTIFACT, `art-${i}`, makeArtifact({ id: `art-${i}`, slug: `art-${i}` }));
    }
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/artifacts?limit=2&offset=2" });
    const body = res.json();
    expect(body.data.items).toHaveLength(2);
    expect(body.data.total).toBe(5);
    expect(body.page.nextCursor).toBe("4");
  });

  it("sorts by latest (updatedAt desc)", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ARTIFACT, "art-1", makeArtifact({ id: "art-1", updatedAt: "2026-01-01T00:00:00Z" }));
    await store.saveProjection(KIND_ARTIFACT, "art-2", makeArtifact({ id: "art-2", slug: "art-2", updatedAt: "2026-03-01T00:00:00Z" }));
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/artifacts?sort=latest" });
    const body = res.json();
    expect(body.data.items[0].id).toBe("art-2");
  });

  it("sorts by hot (hotScore desc)", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ARTIFACT, "art-1", makeArtifact({ id: "art-1", hotScore: 10 }));
    await store.saveProjection(KIND_ARTIFACT, "art-2", makeArtifact({ id: "art-2", slug: "art-2", hotScore: 100 }));
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/artifacts?sort=hot" });
    const body = res.json();
    expect(body.data.items[0].id).toBe("art-2");
  });

  it("sorts by reviewed (reviewCount desc)", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ARTIFACT, "art-1", makeArtifact({ id: "art-1", reviewCount: 1 }));
    await store.saveProjection(KIND_ARTIFACT, "art-2", makeArtifact({ id: "art-2", slug: "art-2", reviewCount: 5 }));
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/artifacts?sort=reviewed" });
    const body = res.json();
    expect(body.data.items[0].id).toBe("art-2");
  });

  it("filters by locale (omits unknown locale artifacts that have locale set)", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ARTIFACT, "art-en", makeArtifact({ id: "art-en", slug: "art-en", locale: "en" }));
    await store.saveProjection(KIND_ARTIFACT, "art-zh", makeArtifact({ id: "art-zh", slug: "art-zh", locale: "zh" }));
    await store.saveProjection(KIND_ARTIFACT, "art-any", makeArtifact({ id: "art-any", slug: "art-any", locale: undefined }));
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/artifacts?locale=en" });
    const body = res.json();
    const ids = body.data.items.map((a: PublicArtifact) => a.id);
    expect(ids).toContain("art-en");
    expect(ids).toContain("art-any");
    expect(ids).not.toContain("art-zh");
  });
});

describe("GET /api/public/artifacts/popular", () => {
  it("returns artifacts sorted by hotScore descending", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ARTIFACT, "art-1", makeArtifact({ id: "art-1", hotScore: 5 }));
    await store.saveProjection(KIND_ARTIFACT, "art-2", makeArtifact({ id: "art-2", slug: "art-2", hotScore: 99 }));
    await store.saveProjection(KIND_ARTIFACT, "art-3", makeArtifact({ id: "art-3", slug: "art-3", hotScore: 50 }));
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/artifacts/popular?limit=2" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0].id).toBe("art-2");
    expect(body.data.items[1].id).toBe("art-3");
  });
});

describe("GET /api/public/artifacts/:slug", () => {
  it("returns the artifact by slug", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ARTIFACT, "art-1", makeArtifact());
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/artifacts/open-intelligence-model" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.artifact.slug).toBe("open-intelligence-model");
  });

  it("returns 404 for unknown slug", async () => {
    const app = await buildApp(makeStore());
    const res = await app.inject({ method: "GET", url: "/api/public/artifacts/no-such-slug" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/public/orgs", () => {
  it("returns org list", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ORG, "org-1", makeOrg());
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/orgs" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  it("filters by q", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ORG, "org-1", makeOrg({ name: "Vibly" }));
    await store.saveProjection(KIND_ORG, "org-2", makeOrg({ id: "org-2", slug: "vibmath", name: "VibMath" }));
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/orgs?q=vibmath" });
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].slug).toBe("vibmath");
  });
});

describe("GET /api/public/orgs/:slug", () => {
  it("returns org by slug", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_ORG, "org-1", makeOrg());
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/orgs/vibly" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.org.slug).toBe("vibly");
  });

  it("returns 404 for unknown slug", async () => {
    const app = await buildApp(makeStore());
    const res = await app.inject({ method: "GET", url: "/api/public/orgs/unknown" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/public/projects", () => {
  it("returns project list", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_PROJECT, "proj-1", makeProject());
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/projects" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });
});

describe("GET /api/public/agents", () => {
  it("returns agent list", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_AGENT, "agent-1", makeAgent());
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/agents" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });
});

describe("GET /api/public/agents/:id", () => {
  it("returns agent by id", async () => {
    const store = makeStore();
    await store.saveProjection(KIND_AGENT, "agent-1", makeAgent());
    const app = await buildApp(store);

    const res = await app.inject({ method: "GET", url: "/api/public/agents/agent-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.agent.id).toBe("agent-1");
  });

  it("returns 404 for unknown agent", async () => {
    const app = await buildApp(makeStore());
    const res = await app.inject({ method: "GET", url: "/api/public/agents/unknown" });
    expect(res.statusCode).toBe(404);
  });
});
