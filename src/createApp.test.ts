import { describe, expect, it } from "vitest";
import { createApp } from "./createApp.js";
import { loadConfig } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import type { CoordinatorStorePort } from "./db/coordinatorStorePort.js";
import { createEventBus } from "./services/eventBus.js";
import type { Concord } from "@concord/sdk";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { saveObservedRelayDeposit } from "./modules/conversion/get-vib/domain.js";
import { IdentityRepository } from "./contexts/identity/repository.js";
import { normalizeSubstrateAccount } from "./services/chainIdentityIndexerSync.js";

function makeStore(): CoordinatorStorePort {
  const projections = new Map<string, Map<string, unknown>>();
  const leases = new Map<string, { id: string; kind: string; resourceId: string; holderId: string; expiresAt: string; createdAt: string; renewedAt?: string }>();
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
    async createLease(input) {
      const id = `lease_${leases.size + 1}`;
      const now = new Date().toISOString();
      const lease = { id, kind: input.kind, resourceId: input.resourceId, holderId: input.holderId, expiresAt: new Date(Date.now() + input.ttlMs).toISOString(), createdAt: now };
      leases.set(id, lease);
      return lease;
    },
    async tryAcquireLease(input) {
      const active = Array.from(leases.values()).find((lease) => lease.kind === input.kind && lease.resourceId === input.resourceId && new Date(lease.expiresAt).getTime() > Date.now());
      if (active) return undefined;
      const id = `lease_${leases.size + 1}`;
      const now = new Date().toISOString();
      const lease = { id, kind: input.kind, resourceId: input.resourceId, holderId: input.holderId, expiresAt: new Date(Date.now() + input.ttlMs).toISOString(), createdAt: now };
      leases.set(id, lease);
      return lease;
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
    async releaseLease(id) {
      leases.delete(id);
    },
    async sweepExpiredLeases() {
      return [];
    },
  };
}

function makeConcord(): Concord {
  const principals: Array<Record<string, unknown>> = [];
  const projects: Array<Record<string, unknown>> = [];
  return {
    governanceIndexQuery: null,
    governanceGateway: {
      submitProposal: async () => ({ id: "mock", status: "submitted" }),
    },
    principals: {
      registerPrincipal: async (input: Record<string, unknown>) => {
        const now = new Date().toISOString();
        const principal = {
          id: `principal_${principals.length + 1}`,
          kind: input.kind,
          displayName: input.displayName,
          description: input.description,
          status: "active",
          identityBindings: input.identityBindings ?? [],
          addressBindings: input.addressBindings ?? [],
          createdAt: now,
          updatedAt: now,
        };
        principals.push(principal);
        return principal;
      },
      getPrincipal: async (principalId: string) => principals.find((principal) => principal.id === principalId) ?? null,
      listPrincipals: async () => principals,
    },
    projects: {
      createProject: async (input: Record<string, unknown>) => {
        if (!principals.some((principal) => principal.id === input.sponsorPrincipalId)) {
          throw new Error(`Principal not found: ${String(input.sponsorPrincipalId)}`);
        }
        if (projects.some((project) => project.slug === input.slug)) {
          throw new Error(`Project slug already exists: ${String(input.slug)}`);
        }
        const now = new Date().toISOString();
        const project = {
          id: `project_${projects.length + 1}`,
          organizationId: input.organizationId,
          slug: input.slug,
          name: input.name,
          description: input.description,
          status: "draft",
          sponsorPrincipalId: input.sponsorPrincipalId,
          metadata: input.metadata,
          createdAt: now,
          updatedAt: now,
        };
        projects.push(project);
        return project;
      },
      getProject: async (projectId: string) => projects.find((project) => project.id === projectId) ?? null,
      getProjectBySlug: async (slug: string) => projects.find((project) => project.slug === slug) ?? null,
      listProjects: async () => projects,
    },
    state: {
      events: { append: async () => {} },
    },
  } as unknown as Concord;
}

describe("createApp governance runtime config", () => {
  it("can register substrate-local and evm-fixture descriptors in one process", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "none",
      GOVERNANCE_BACKENDS: "substrate-local,evm-fixture",
      SUBSTRATE_INDEXER_URL: "http://localhost:3010/graphql",
      SUBSTRATE_CHAIN_ID: "substrate:vibly-solo",
      EVM_CHAIN_ID: "31337",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const res = await app.inject({ method: "GET", url: "/governance/backends" });
    const body = res.json<{ data: { backends: { id: string; backend: string; chain: { namespace: string; chainId: string } }[] } }>();

    expect(body.data.backends).toMatchObject([
      {
        id: "substrate-local",
        backend: "substrate-opengov",
        chain: { namespace: "substrate", chainId: "substrate:vibly-solo" },
      },
      {
        id: "evm-fixture",
        backend: "evm-governor",
        chain: { namespace: "eip155", chainId: "31337" },
      },
    ]);

    await app.close();
  }, 15000);

  it("keeps the legacy single-backend substrate path", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "none",
      SUBSTRATE_INDEXER_URL: "http://localhost:3010/graphql",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const res = await app.inject({ method: "GET", url: "/governance/backends" });
    const body = res.json<{ data: { backends: { id: string; backend: string }[] } }>();

    expect(body.data.backends).toHaveLength(1);
    expect(body.data.backends[0]).toMatchObject({
      id: "substrate-local",
      backend: "substrate-opengov",
    });

    await app.close();
  });

  it("allows anonymous access to public-read routes in static-token mode", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const response = await app.inject({ method: "GET", url: "/feed" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; data: { items: unknown[] } }>();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);

    await app.close();
  });

  it("rejects anonymous access to private and write routes in static-token mode", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const privateRead = await app.inject({ method: "GET", url: "/agents/demo/inbox" });
    const write = await app.inject({
      method: "POST",
      url: "/action-intents",
      payload: { type: "Ping", principalId: "p1", payload: {} },
    });

    expect(privateRead.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);

    await app.close();
  });

  it("exposes Get VIB relay watcher status and finalizes observed relay deposits", async () => {
    const store = makeStore();
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "none",
      SUBSTRATE_CHAIN_ID: "local:get-vib-test",
      VIBLY_DOT_RECEIVING_ADDRESS: "deposit",
      VIBLY_CONVERSION_INITIAL_RATE: "1000",
      GET_VIB_RELAY_CHAIN_ID: "polkadot-dev",
    });
    const observed = await saveObservedRelayDeposit(store, {
      relayChainId: "polkadot-dev",
      sourceId: "polkadot-dev:0xabc:0:1",
      from: "from",
      to: "deposit",
      amountBaseUnits: "10000000000",
      dotAmount: "1",
      blockNumber: 1,
      blockHash: "0xabc",
      extrinsicIndex: 0,
      eventIndex: 1,
      extrinsicHash: "0xtx",
      finalizedAt: "2026-05-24T00:00:00.000Z",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: store,
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const statusRes = await app.inject({ method: "GET", url: "/admin/get-vib/relay-watcher/status" });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json<{ data: { status: { status: string } } }>().data.status.status).toBe("disabled");

    const listRes = await app.inject({ method: "GET", url: "/admin/get-vib/relay-deposits?status=observed" });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json<{ data: { deposits: unknown[] } }>().data.deposits).toHaveLength(1);

    const finalizeRes = await app.inject({
      method: "POST",
      url: "/admin/get-vib/deposits/finalize",
      payload: {
        observedDepositId: observed.deposit.id,
        accountId: "0x1111111111111111111111111111111111111111111111111111111111111111",
      },
    });
    expect(finalizeRes.statusCode).toBe(200);
    const finalizeBody = finalizeRes.json<{ data: { result: { allocation: { vibAmount: string } } } }>();
    expect(finalizeBody.data.result.allocation.vibAmount).toMatch(/^1097\./);
    expect(Number(finalizeBody.data.result.allocation.vibAmount)).toBeGreaterThanOrEqual(1097);
    expect(Number(finalizeBody.data.result.allocation.vibAmount)).toBeLessThan(1098);

    await app.close();
  });

  it("supports wallet challenge/session lifecycle for polkadot signatures", async () => {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const pair = keyring.addFromUri("//Alice");

    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const challengeRes = await app.inject({
      method: "POST",
      url: "/wallet/challenges",
      payload: {
        ecosystem: "polkadot",
        address: pair.address,
      },
    });
    expect(challengeRes.statusCode).toBe(200);
    const challengeBody = challengeRes.json<{ data: { challenge: { id: string; message: string } } }>();
    const challengeId = challengeBody.data.challenge.id;
    const message = challengeBody.data.challenge.message;

    const signatureHex = toHex(pair.sign(new TextEncoder().encode(message)));
    const sessionRes = await app.inject({
      method: "POST",
      url: "/wallet/sessions",
      payload: {
        challengeId,
        ecosystem: "polkadot",
        address: pair.address,
        signature: signatureHex,
      },
    });
    expect(sessionRes.statusCode).toBe(200);
    const sessionBody = sessionRes.json<{ data: { session: { token: string } } }>();
    const token = sessionBody.data.session.token;

    const getRes = await app.inject({
      method: "GET",
      url: "/wallet/session",
      headers: { "x-wallet-session": token },
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json<{ data: { session: { token: string } } }>();
    expect(getBody.data.session.token).toBe(token);

    const delRes = await app.inject({
      method: "DELETE",
      url: "/wallet/session",
      headers: { "x-wallet-session": token },
    });
    expect(delRes.statusCode).toBe(200);
    const delBody = delRes.json<{ data: { session: { revokedAt?: string } } }>();
    expect(typeof delBody.data.session.revokedAt).toBe("string");

    await app.close();
  });

  it("rejects wallet action-intent principalId spoofing", async () => {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const alice = keyring.addFromUri("//Alice");
    const bob = keyring.addFromUri("//Bob");
    const store = makeStore();
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
      ORG_ADMIN_AUTHORITY_SOURCE: "local",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: store,
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });
    const token = await createWalletSession(app, alice.address, alice);

    const res = await app.inject({
      method: "POST",
      url: "/action-intents",
      headers: {
        authorization: "Bearer dev-token",
        "x-wallet-session": token,
      },
      payload: {
        type: "CreateOrganization",
        principalId: bob.address,
        payload: { name: "Wallet-owned Org" },
      },
    });

    expect(res.statusCode).toBe(403);
    const orgs = await store.listProjections("organization_v2");
    expect(orgs).toHaveLength(0);

    await app.close();
  });

  it("allows an organization admin wallet session to create a project", async () => {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const admin = keyring.addFromUri("//Alice");
    const store = makeStore();
    const concord = makeConcord();
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
      ORG_ADMIN_AUTHORITY_SOURCE: "guardian",
      CHAIN_AUTHORITY_MODE: "disabled",
    });
    const now = new Date().toISOString();
    await store.saveProjection("organization_v2", "org_admin", {
      id: "org_admin",
      name: "Admin Org",
      status: "active",
      members: [{ principalId: admin.address, role: "admin", joinedAt: now }],
      authorities: [],
      createdBy: admin.address,
      createdAt: now,
      updatedAt: now,
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord,
      coordinatorStore: store,
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });
    const token = await createWalletSession(app, admin.address, admin);

    const res = await app.inject({
      method: "POST",
      url: "/action-intents",
      headers: {
        authorization: "Bearer dev-token",
        "x-wallet-session": token,
      },
      payload: {
        type: "CreateProject",
        payload: {
          organizationId: "org_admin",
          slug: "admin-project",
          name: "Admin Project",
          description: "Created from wallet session",
          metadata: { organizationId: "forged-org", source: "test" },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { aggregateRef: { kind: string; id: string } } }>();
    expect(body.data.aggregateRef.kind).toBe("Project");
    const project = await concord.projects.getProject(body.data.aggregateRef.id as never);
    expect(project).toMatchObject({
      id: body.data.aggregateRef.id,
      organizationId: "org_admin",
      slug: "admin-project",
      name: "Admin Project",
    });
    expect(project?.metadata).toMatchObject({
      organizationId: "org_admin",
      source: "test",
      createdBy: admin.address,
    });

    await app.close();
  });

  it("rejects a normal agent wallet session for project creation", async () => {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const agent = keyring.addFromUri("//Bob");
    const store = makeStore();
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
      ORG_ADMIN_AUTHORITY_SOURCE: "guardian",
      CHAIN_AUTHORITY_MODE: "disabled",
    });
    const now = new Date().toISOString();
    await store.saveProjection("organization_v2", "org_agent", {
      id: "org_agent",
      name: "Agent Org",
      status: "active",
      members: [{ principalId: agent.address, role: "member", joinedAt: now }],
      authorities: [],
      createdBy: agent.address,
      createdAt: now,
      updatedAt: now,
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: store,
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });
    const token = await createWalletSession(app, agent.address, agent);

    const res = await app.inject({
      method: "POST",
      url: "/action-intents",
      headers: {
        authorization: "Bearer dev-token",
        "x-wallet-session": token,
      },
      payload: {
        type: "CreateProject",
        payload: {
          organizationId: "org_agent",
          slug: "agent-project",
          name: "Agent Project",
        },
      },
    });

    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it("returns an empty personal center without a wallet session", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const res = await app.inject({ method: "GET", url: "/personal-center" });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { personalCenter: { session: null; agents: unknown[] } } }>();
    expect(body.data.personalCenter.session).toBeNull();
    expect(body.data.personalCenter.agents).toEqual([]);

    await app.close();
  });

  it("returns indexed Polkadot root identity in personal center", async () => {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const root = keyring.addFromUri("//Alice");
    const store = makeStore();
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
      SUBSTRATE_CHAIN_ID: "substrate:vibly-solo",
    });
    await new IdentityRepository(store).saveChainRootIdentity({
      id: `${config.substrateChainId}:${normalizeSubstrateAccount(root.address)}`,
      chainId: config.substrateChainId,
      identityId: "0xidentity",
      ownerAddress: root.address,
      ownerAccountHex: normalizeSubstrateAccount(root.address),
      status: "active",
      updatedAtBlock: "12",
      indexedAt: new Date().toISOString(),
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: store,
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });
    const token = await createWalletSession(app, root.address, root);

    const res = await app.inject({
      method: "GET",
      url: "/personal-center",
      headers: { "x-wallet-session": token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { personalCenter: { identity: { identityId: string; status: string; viblyRootAddress: string } | null; alerts: Array<{ id: string }> } } }>();
    expect(body.data.personalCenter.identity).toMatchObject({
      identityId: "0xidentity",
      status: "active",
      viblyRootAddress: root.address,
    });
    expect(body.data.personalCenter.alerts.some((alert) => alert.id === "identity-missing")).toBe(false);

    await app.close();
  });

  it("authorizes, lists, and revokes an agent session key", async () => {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const root = keyring.addFromUri("//Alice");
    const agent = keyring.addFromUri("//Bob");

    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });
    const token = await createWalletSession(app, root.address, root);

    const challengeRes = await app.inject({
      method: "POST",
      url: "/agent-enrollments/challenges",
      headers: { "x-wallet-session": token },
      payload: {
        descriptor: {
          displayName: "Observer Agent",
          sessionPublicKey: agent.address,
          capabilities: ["observer"],
          organizationIds: ["default"],
          scopes: ["availability", "task_result"],
          stakeLimit: "100",
          identityId: "identity-1",
          chainAgentId: "chain-agent-1",
          chainId: "substrate:vibly-solo",
        },
      },
    });
    expect(challengeRes.statusCode).toBe(200);
    const challenge = challengeRes.json<{ data: { challenge: { id: string; message: string; rootAuthorizationMessage: string } } }>().data.challenge;

    const authorizeRes = await app.inject({
      method: "POST",
      url: "/agent-enrollments/authorizations",
      headers: { "x-wallet-session": token },
      payload: {
        challengeId: challenge.id,
        sessionSignature: toHex(agent.sign(new TextEncoder().encode(challenge.message))),
        rootAuthorizationSignature: toHex(root.sign(new TextEncoder().encode(challenge.rootAuthorizationMessage))),
      },
    });
    expect(authorizeRes.statusCode).toBe(200);
    const authorization = authorizeRes.json<{ data: { authorization: { principalId: string; runtimeToken: string; sessionKey: { id: string }; profile: { principalId: string; sessionKeys: unknown[] } } } }>().data.authorization;
    expect(authorization.profile.sessionKeys).toHaveLength(1);
    expect(authorization.runtimeToken).toMatch(/^vibly_agent_rt_/);

    const heartbeatRes = await app.inject({
      method: "POST",
      url: `/agents/${authorization.principalId}/heartbeat`,
      headers: { authorization: `Bearer ${authorization.runtimeToken}` },
      payload: { availability: "available", clientVersion: "0.2.0" },
    });
    expect(heartbeatRes.statusCode).toBe(200);

    const crossAgentHeartbeatRes = await app.inject({
      method: "POST",
      url: "/agents/agent_someone_else/heartbeat",
      headers: { authorization: `Bearer ${authorization.runtimeToken}` },
      payload: { availability: "available", clientVersion: "0.2.0" },
    });
    expect(crossAgentHeartbeatRes.statusCode).toBe(401);

    const reuseRes = await app.inject({
      method: "POST",
      url: "/agent-enrollments/authorizations",
      headers: { "x-wallet-session": token },
      payload: {
        challengeId: challenge.id,
        sessionSignature: toHex(agent.sign(new TextEncoder().encode(challenge.message))),
        rootAuthorizationSignature: toHex(root.sign(new TextEncoder().encode(challenge.rootAuthorizationMessage))),
      },
    });
    expect(reuseRes.statusCode).toBe(409);

    const centerRes = await app.inject({
      method: "GET",
      url: "/personal-center",
      headers: { "x-wallet-session": token },
    });
    expect(centerRes.statusCode).toBe(200);
    const center = centerRes.json<{ data: { personalCenter: { agents: unknown[]; securityEvents: unknown[] } } }>().data.personalCenter;
    expect(center.agents).toHaveLength(1);
    expect(center.securityEvents).toHaveLength(1);

    const revokeRes = await app.inject({
      method: "POST",
      url: `/agent-enrollments/${authorization.sessionKey.id}/revoke`,
      headers: { "x-wallet-session": token },
      payload: { reason: "test" },
    });
    expect(revokeRes.statusCode).toBe(200);

    await app.close();
  });

  it("directly adds an agent session key from an enrollment descriptor", async () => {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const root = keyring.addFromUri("//Alice");
    const agent = keyring.addFromUri("//Charlie");

    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });
    const token = await createWalletSession(app, root.address, root);

    const addRes = await app.inject({
      method: "POST",
      url: "/agent-enrollments",
      headers: { "x-wallet-session": token },
      payload: {
        descriptor: {
          displayName: "Direct Agent",
          sessionPublicKey: agent.address,
          localAgentId: "local-agent-1",
          capabilities: ["observer"],
          organizationIds: ["default"],
          scopes: ["availability", "task_result"],
          identityId: "identity-1",
          chainAgentId: "chain-agent-1",
          chainId: "substrate:vibly-solo",
        },
      },
    });
    expect(addRes.statusCode).toBe(200);
    const authorization = addRes.json<{ data: { authorization: { principalId: string; runtimeToken: string; sessionKey: { proof: { mode: string } }; profile: { sessionKeys: unknown[] } } } }>().data.authorization;
    expect(authorization.profile.sessionKeys).toHaveLength(1);
    expect(authorization.sessionKey.proof.mode).toBe("direct-console");
    expect(authorization.runtimeToken).toMatch(/^vibly_agent_rt_/);

    const heartbeatRes = await app.inject({
      method: "POST",
      url: `/agents/${authorization.principalId}/heartbeat`,
      headers: { authorization: `Bearer ${authorization.runtimeToken}` },
      payload: { availability: "available", clientVersion: "0.2.0" },
    });
    expect(heartbeatRes.statusCode).toBe(200);

    await app.close();
  });

  it("authorizes a session public key and lets the local agent complete enrollment", async () => {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const root = keyring.addFromUri("//Alice");
    const agent = keyring.addFromUri("//Dave");

    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });
    const token = await createWalletSession(app, root.address, root);

    const authorizeKeyRes = await app.inject({
      method: "POST",
      url: "/agent-enrollments/public-keys",
      headers: { "x-wallet-session": token },
      payload: {
        sessionPublicKey: agent.address,
        keyType: "sr25519",
        displayName: "Linked Agent",
        organizationIds: ["default"],
      },
    });
    expect(authorizeKeyRes.statusCode).toBe(200);
    const rootAuthorization = authorizeKeyRes.json<{ data: { authorization: { id: string; status: string; completionMessage: string; sessionPublicKey: string } } }>().data.authorization;
    expect(rootAuthorization.status).toBe("pending_client");
    expect(rootAuthorization.sessionPublicKey).toBe(agent.address);
    expect(rootAuthorization.completionMessage).toContain(rootAuthorization.id);

    const statusRes = await app.inject({
      method: "GET",
      url: `/agent-enrollments/status?sessionPublicKey=${encodeURIComponent(agent.address)}`,
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json<{ data: { authorization: { status: string } } }>().data.authorization.status).toBe("pending_client");

    const completeRes = await app.inject({
      method: "POST",
      url: "/agent-enrollments/complete",
      payload: {
        descriptor: {
          displayName: "Linked Agent",
          sessionPublicKey: agent.address,
          keyType: "sr25519",
          localAgentId: "local-agent-2",
          capabilities: ["observer"],
          organizationIds: ["default"],
          scopes: ["availability", "task_result"],
          identityId: "identity-2",
          chainAgentId: "chain-agent-2",
          chainId: "substrate:vibly-solo",
        },
        sessionSignature: toHex(agent.sign(new TextEncoder().encode(rootAuthorization.completionMessage))),
      },
    });
    expect(completeRes.statusCode).toBe(200);
    const authorization = completeRes.json<{ data: { authorization: { principalId: string; runtimeToken: string; sessionKey: { proof: { mode: string; authorizationId: string } }; rootAuthorization: { status: string } } } }>().data.authorization;
    expect(authorization.runtimeToken).toMatch(/^vibly_agent_rt_/);
    expect(authorization.sessionKey.proof.mode).toBe("console-public-key");
    expect(authorization.sessionKey.proof.authorizationId).toBe(rootAuthorization.id);
    expect(authorization.rootAuthorization.status).toBe("completed");

    const completedStatusRes = await app.inject({
      method: "GET",
      url: `/agent-enrollments/status?sessionPublicKey=${encodeURIComponent(agent.address)}`,
    });
    expect(completedStatusRes.statusCode).toBe(200);
    const completedStatus = completedStatusRes.json<{ data: { authorization: { status: string; completionMessage?: string } } }>().data.authorization;
    expect(completedStatus.status).toBe("completed");
    expect(completedStatus.completionMessage).toBe(rootAuthorization.completionMessage);

    const heartbeatRes = await app.inject({
      method: "POST",
      url: `/agents/${authorization.principalId}/heartbeat`,
      headers: { authorization: `Bearer ${authorization.runtimeToken}` },
      payload: { availability: "available", clientVersion: "0.2.0" },
    });
    expect(heartbeatRes.statusCode).toBe(200);

    await app.close();
  });
});

function toHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

async function createWalletSession(app: Awaited<ReturnType<typeof createApp>>, address: string, pair: { sign(input: Uint8Array): Uint8Array }) {
  const challengeRes = await app.inject({
    method: "POST",
    url: "/wallet/challenges",
    payload: { ecosystem: "polkadot", address },
  });
  const challengeBody = challengeRes.json<{ data: { challenge: { id: string; message: string } } }>();
  const sessionRes = await app.inject({
    method: "POST",
    url: "/wallet/sessions",
    payload: {
      challengeId: challengeBody.data.challenge.id,
      ecosystem: "polkadot",
      address,
      signature: toHex(pair.sign(new TextEncoder().encode(challengeBody.data.challenge.message))),
    },
  });
  return sessionRes.json<{ data: { session: { token: string } } }>().data.session.token;
}

describe("client version policy", () => {
  it("publishes version policy and rejects protected requests from old clients", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
      STORAGE_MODE: "memory",
      CLIENT_VERSION_ENFORCEMENT: "true",
      MINIMUM_CLIENT_VERSION: "0.2.0",
      RECOMMENDED_CLIENT_VERSION: "0.3.0",
      MINIMUM_CONTRACT_VERSION: "0.1.0",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const policy = await app.inject({ method: "GET", url: "/version-policy" });
    expect(policy.statusCode).toBe(200);
    expect(policy.json<{ data: { policy: { minimumClientVersion: string } } }>().data.policy.minimumClientVersion).toBe("0.2.0");

    const rejected = await app.inject({
      method: "POST",
      url: "/action-intents",
      headers: { authorization: "Bearer dev-token", "x-vibly-client-version": "0.1.0" },
      payload: {},
    });
    expect(rejected.statusCode).toBe(426);
    expect(rejected.json<{ error: { code: string } }>().error.code).toBe("UPGRADE_REQUIRED");

    const acceptedByGate = await app.inject({
      method: "POST",
      url: "/action-intents",
      headers: { authorization: "Bearer dev-token", "x-vibly-client-version": "0.2.0" },
      payload: {},
    });
    expect(acceptedByGate.statusCode).not.toBe(426);

    await app.close();
  });
});

describe("network manifests", () => {
  it("publishes public network manifests with incentivized testnet feature gates", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "static-token",
      API_TOKENS: "dev-token",
      STORAGE_MODE: "memory",
      CLIENT_VERSION_ENFORCEMENT: "true",
      MINIMUM_CLIENT_VERSION: "0.2.0",
      RECOMMENDED_CLIENT_VERSION: "0.3.0",
    });
    const app = await createApp({
      config,
      logger: createLogger(config),
      concord: makeConcord(),
      coordinatorStore: makeStore(),
      eventBus: createEventBus(),
      startGovernanceConsumers: false,
    });

    const list = await app.inject({ method: "GET", url: "/networks" });
    expect(list.statusCode).toBe(200);
    const networks = list.json<{ data: { networks: Array<{ id: string; features: Record<string, boolean>; status: string; minimumClientVersion?: string }> } }>().data.networks;
    const incentivized = networks.find((network) => network.id === "substrate:vibly-incentivized-testnet");
    expect(incentivized).toMatchObject({
      status: "prelaunch",
      minimumClientVersion: "0.2.0",
      features: {
        getVibConversion: true,
        getVibClaim: false,
        agentJoin: false,
        daemon: false,
        staking: false,
      },
    });
    expect(JSON.stringify(networks)).not.toMatch(/dev-token|signerUri|authorityUri|\/\/Alice|\/\/RootPublisher/i);

    const one = await app.inject({ method: "GET", url: "/networks/substrate%3Avibly-incentivized-testnet" });
    expect(one.statusCode).toBe(200);
    expect(one.json<{ data: { network: { id: string } } }>().data.network.id).toBe("substrate:vibly-incentivized-testnet");

    await app.close();
  });
});
