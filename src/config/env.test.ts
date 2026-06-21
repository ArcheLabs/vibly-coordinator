import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./env.js";

describe("loadConfig", () => {
  it("keeps legacy governance backend toggles working by default", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      SUBSTRATE_INDEXER_URL: "http://localhost:3010/graphql",
      EVM_GOVERNOR_FIXTURE: "true",
    });

    expect(config.governanceBackends).toEqual([]);
    expect(config.substrateIndexerUrl).toBe("http://localhost:3010/graphql");
    expect(config.evmGovernorFixture).toBe(true);
    expect(config.substrateChainId).toBe("substrate:vibly-solo");
    expect(config.substrateRpcUrl).toBe("ws://127.0.0.1:9944");
    expect(config.substrateGovernanceTxMode).toBe("prepare-only");
    expect(config.evmChainId).toBe("31337");
  });

  it("parses an explicit multi-backend allowlist for the D5 demo path", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      GOVERNANCE_BACKENDS: "substrate-local, evm-fixture",
    });

    expect(config.governanceBackends).toEqual(["substrate-local", "evm-fixture"]);
  });

  it("parses Phase E substrate OpenGov tx mode", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      SUBSTRATE_RPC_URL: "ws://localhost:9944",
      SUBSTRATE_GOVERNANCE_TX_MODE: "fixture",
    });

    expect(config.substrateRpcUrl).toBe("ws://localhost:9944");
    expect(config.substrateGovernanceTxMode).toBe("fixture");
  });

  it("parses dedicated agent reward production controls", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      AGENT_REWARD_ENABLED: "true",
      SUBSTRATE_INDEXER_URL: "http://localhost:3000/graphql",
      SUBSTRATE_RPC_URL: "ws://localhost:9944",
      AGENT_REWARD_SYNC_INTERVAL_MS: "45000",
      AGENT_REWARD_SETTLEMENT_INTERVAL_MS: "30000",
      AGENT_REWARD_TX_MODE: "unsafe-papi",
      AGENT_REWARD_PUBLISHER_URI: "//RewardPublisher",
      AGENT_REWARD_EMISSION_START_AT: "2026-06-01T00:00:00.000Z",
      AGENT_REWARD_MAX_CATCHUP_DAYS: "3",
      LEGACY_REWARD_INTENT_MODE: "disabled",
    });

    expect(config.agentRewardEnabled).toBe(true);
    expect(config.agentRewardSyncIntervalMs).toBe(45000);
    expect(config.agentRewardSettlementIntervalMs).toBe(30000);
    expect(config.agentRewardTxMode).toBe("unsafe-papi");
    expect(config.agentRewardPublisherUri).toBe("//RewardPublisher");
    expect(config.agentRewardEmissionStartAt).toBe("2026-06-01T00:00:00.000Z");
    expect(config.agentRewardMaxCatchupDays).toBe(3);
    expect(config.legacyRewardIntentMode).toBe("disabled");
  });

  it("requires reward publisher URI in unsafe-papi mode", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        AGENT_REWARD_TX_MODE: "unsafe-papi",
      }),
    ).toThrow(/AGENT_REWARD_PUBLISHER_URI/);
  });

  it("requires reward infra when agent rewards are enabled", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        AGENT_REWARD_ENABLED: "true",
      }),
    ).toThrow(/AGENT_REWARD_EMISSION_START_AT/);
  });

  const validProductionStatic = {
    NODE_ENV: "production" as const,
    STORAGE_MODE: "postgres",
    DATABASE_URL: "postgres://localhost:5432/coordinator",
    API_AUTH_MODE: "static-token",
    API_TOKENS: "prod-token-1,prod-token-2",
    ENABLE_DEV_ROUTES: "false",
    CLIENT_VERSION_ENFORCEMENT: "true",
    CHAIN_AUTHORITY_MODE: "rpc",
    ORG_ADMIN_AUTHORITY_SOURCE: "guardian",
    NETWORK_MANIFEST_JSON: JSON.stringify([
      {
        manifestVersion: 1,
        updatedAt: "2026-06-02T00:00:00.000Z",
        ttlSeconds: 600,
        id: "substrate:vibly-incentivized-testnet",
        label: "Monolith",
        stage: "testnet",
        status: "prelaunch",
        coordinatorUrls: ["https://api.vibly.network"],
        chains: {
          vibly: {
            chainId: "substrate:vibly-incentivized-testnet",
            status: "prelaunch",
            rpcUrls: [],
          },
        },
        features: {
          agentJoin: false,
          daemon: false,
          staking: false,
          rootIdentityRegistration: false,
        },
      },
    ]),
  };

  it("accepts a minimal valid production configuration", () => {
    const config = loadConfig(validProductionStatic);
    expect(config.storageMode).toBe("postgres");
    expect(config.apiAuthMode).toBe("static-token");
    expect(config.databaseUrl).toMatch(/^postgres/);
  });

  it("accepts production network manifests from a file without hand-written genesis hashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibly-manifest-"));
    const file = join(dir, "network-manifest.json");
    writeFileSync(file, validProductionStatic.NETWORK_MANIFEST_JSON);

    const config = loadConfig({
      ...validProductionStatic,
      NETWORK_MANIFEST_JSON: "",
      NETWORK_MANIFEST_FILE: file,
    });
    expect(config.networkManifestFile).toBe(file);
    expect(config.networkManifestJson).toContain("Monolith");
  });

  it("rejects production when storage is not postgres", () => {
    expect(() =>
      loadConfig({
        ...validProductionStatic,
        STORAGE_MODE: "sqlite",
      }),
    ).toThrow();
  });

  it("rejects production DATABASE_URL that is not postgres", () => {
    expect(() =>
      loadConfig({
        ...validProductionStatic,
        DATABASE_URL: "file:./data/app.db",
      }),
    ).toThrow();
  });

  it("rejects production auth mode none", () => {
    expect(() =>
      loadConfig({
        ...validProductionStatic,
        API_AUTH_MODE: "none",
      }),
    ).toThrow();
  });

  it("rejects production default dev token", () => {
    expect(() =>
      loadConfig({
        ...validProductionStatic,
        API_TOKENS: "dev-token",
      }),
    ).toThrow(/dev-token/);
  });

  it("rejects production with empty API_TOKENS", () => {
    expect(() =>
      loadConfig({
        ...validProductionStatic,
        API_TOKENS: " , ",
      }),
    ).toThrow(/API_TOKENS/);
  });

  it("rejects production with dev routes enabled", () => {
    expect(() =>
      loadConfig({
        ...validProductionStatic,
        ENABLE_DEV_ROUTES: "true",
      }),
    ).toThrow();
  });
});
