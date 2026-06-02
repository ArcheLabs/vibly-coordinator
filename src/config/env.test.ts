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
      GET_VIB_RELAY_TOKEN_SYMBOL: "PLA",
      GET_VIB_RELAY_TOKEN_DECIMALS: "10",
      GET_VIB_DEPOSIT_SCAN_INTERVAL_MS: "3000",
      GET_VIB_DEPOSIT_START_BLOCK: "12",
      GET_VIB_DEPOSIT_FINALITY_BLOCKS: "2",
    });

    expect(config.getVibRelayRpcUrl).toBe("ws://127.0.0.1:9944");
    expect(config.getVibRelayChainId).toBe("polkadot-dev");
    expect(config.getVibRelayTokenSymbol).toBe("PLA");
    expect(config.getVibRelayTokenDecimals).toBe(10);
    expect(config.getVibDepositScanIntervalMs).toBe(3000);
    expect(config.getVibDepositStartBlock).toBe(12);
    expect(config.getVibDepositFinalityBlocks).toBe(2);
  });


  it("parses Get VIB root uploader settings", () => {
    const defaults = loadConfig({ NODE_ENV: "test" });
    expect(defaults.getVibRootUploadIntervalMs).toBe(600000);
    expect(defaults.getVibRootUploadMode).toBe("prepare-only");

    const disabled = loadConfig({
      NODE_ENV: "test",
      GET_VIB_ROOT_UPLOAD_INTERVAL_MS: "0",
      GET_VIB_ROOT_UPLOAD_MODE: "unsafe-papi",
      GET_VIB_ROOT_PUBLISHER_URI: "//RootPublisher",
    });
    expect(disabled.getVibRootUploadIntervalMs).toBe(0);
    expect(disabled.getVibRootUploadMode).toBe("unsafe-papi");
    expect(disabled.getVibRootPublisherUri).toBe("//RootPublisher");
  });

  it("requires a Get VIB root publisher URI in unsafe-papi mode", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        GET_VIB_ROOT_UPLOAD_MODE: "unsafe-papi",
      }),
    ).toThrow(/GET_VIB_ROOT_PUBLISHER_URI/);
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
    CLIENT_VERSION_ENFORCEMENT: "true",
    NETWORK_MANIFEST_JSON: JSON.stringify([
      {
        manifestVersion: 1,
        updatedAt: "2026-06-02T00:00:00.000Z",
        ttlSeconds: 600,
        id: "substrate:vibly-incentivized-testnet",
        label: "Incentivized Testnet",
        stage: "testnet",
        status: "prelaunch",
        coordinatorUrls: ["https://api.vibly.network"],
        chains: {
          payment: {
            chainId: "polkadot",
            genesisHash: "0x91b171bb158e2d3848fa23a9f1c25182",
            status: "online",
            rpcUrls: ["wss://rpc.polkadot.io"],
          },
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
          getVibConversion: true,
          getVibClaim: false,
        },
      },
    ]),
  };

  it("accepts a minimal valid production configuration", () => {
    const config = loadConfig(validProductionOidc);
    expect(config.storageMode).toBe("postgres");
    expect(config.apiAuthMode).toBe("oidc");
    expect(config.databaseUrl).toMatch(/^postgres/);
  });

  it("rejects production network manifests with online chains missing genesis hashes", () => {
    expect(() =>
      loadConfig({
        ...validProductionOidc,
        NETWORK_MANIFEST_JSON: JSON.stringify([
          {
            manifestVersion: 1,
            updatedAt: "2026-06-02T00:00:00.000Z",
            ttlSeconds: 600,
            id: "substrate:vibly-incentivized-testnet",
            label: "Incentivized Testnet",
            stage: "testnet",
            status: "active",
            coordinatorUrls: ["https://api.vibly.network"],
            chains: {
              payment: { chainId: "polkadot", status: "online", rpcUrls: ["wss://rpc.polkadot.io"] },
              vibly: { chainId: "substrate:vibly-incentivized-testnet", status: "online", rpcUrls: ["wss://rpc.vibly.network"] },
            },
            features: {
              agentJoin: true,
              daemon: true,
              staking: true,
              rootIdentityRegistration: true,
              getVibConversion: true,
              getVibClaim: true,
            },
          },
        ]),
      }),
    ).toThrow(/genesisHash/);
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
