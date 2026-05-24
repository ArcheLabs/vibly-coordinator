import { describe, expect, it } from "vitest";
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

  it("parses Get VIB relay watcher settings", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      GET_VIB_RELAY_RPC_URL: "ws://127.0.0.1:9944",
      GET_VIB_RELAY_CHAIN_ID: "polkadot-dev",
      GET_VIB_RELAY_TOKEN_DECIMALS: "10",
      GET_VIB_DEPOSIT_SCAN_INTERVAL_MS: "3000",
      GET_VIB_DEPOSIT_START_BLOCK: "12",
      GET_VIB_DEPOSIT_FINALITY_BLOCKS: "2",
    });

    expect(config.getVibRelayRpcUrl).toBe("ws://127.0.0.1:9944");
    expect(config.getVibRelayChainId).toBe("polkadot-dev");
    expect(config.getVibRelayTokenDecimals).toBe(10);
    expect(config.getVibDepositScanIntervalMs).toBe(3000);
    expect(config.getVibDepositStartBlock).toBe(12);
    expect(config.getVibDepositFinalityBlocks).toBe(2);
  });

  const validProductionOidc = {
    NODE_ENV: "production" as const,
    STORAGE_MODE: "postgres",
    DATABASE_URL: "postgres://localhost:5432/coordinator",
    API_AUTH_MODE: "oidc",
    OIDC_ISSUER: "https://idp.example",
    OIDC_AUDIENCE: "coordinator-api",
    OIDC_JWKS_URL: "https://idp.example/.well-known/jwks.json",
    ENABLE_DEV_ROUTES: "false",
  };

  it("accepts a minimal valid production configuration", () => {
    const config = loadConfig(validProductionOidc);
    expect(config.storageMode).toBe("postgres");
    expect(config.apiAuthMode).toBe("oidc");
    expect(config.databaseUrl).toMatch(/^postgres/);
  });

  it("rejects production when storage is not postgres", () => {
    expect(() =>
      loadConfig({
        ...validProductionOidc,
        STORAGE_MODE: "sqlite",
      }),
    ).toThrow();
  });

  it("rejects production DATABASE_URL that is not postgres", () => {
    expect(() =>
      loadConfig({
        ...validProductionOidc,
        DATABASE_URL: "file:./data/app.db",
      }),
    ).toThrow();
  });

  it("rejects production static-token auth", () => {
    expect(() =>
      loadConfig({
        ...validProductionOidc,
        API_AUTH_MODE: "static-token",
      }),
    ).toThrow();
  });

  it("rejects production with dev routes enabled", () => {
    expect(() =>
      loadConfig({
        ...validProductionOidc,
        ENABLE_DEV_ROUTES: "true",
      }),
    ).toThrow();
  });
});
