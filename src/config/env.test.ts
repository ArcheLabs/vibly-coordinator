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
    expect(defaults.getVibRootUploadIntervalMs).toBe(120000);
    expect(defaults.getVibRootUploadMode).toBe("prepare-only");
    expect(defaults.getVibClaimEnabled).toBe(false);

    const disabled = loadConfig({
      NODE_ENV: "test",
      GET_VIB_CLAIM_ENABLED: "true",
      GET_VIB_ROOT_UPLOAD_INTERVAL_MS: "0",
      GET_VIB_ROOT_UPLOAD_MODE: "unsafe-papi",
      GET_VIB_ROOT_PUBLISHER_URI: "//RootPublisher",
    });
    expect(disabled.getVibRootUploadIntervalMs).toBe(0);
    expect(disabled.getVibRootUploadMode).toBe("unsafe-papi");
    expect(disabled.getVibRootPublisherUri).toBe("//RootPublisher");
    expect(disabled.getVibClaimEnabled).toBe(true);
  });

  it("requires a Get VIB root publisher URI in unsafe-papi mode", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        GET_VIB_ROOT_UPLOAD_MODE: "unsafe-papi",
      }),
    ).toThrow(/GET_VIB_ROOT_PUBLISHER_URI/);
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
    VIBLY_DOT_RECEIVING_ADDRESS: "15oF4QnYy8Cq9vxufg9cB1HnYqHS8dJHEgHSZ1RPs3m7X5ZV",
    GET_VIB_RELAY_RPC_URL: "wss://rpc.polkadot.io",
    GET_VIB_RELAY_CHAIN_ID: "polkadot",
    GET_VIB_RELAY_TOKEN_DECIMALS: "10",
    GET_VIB_DEPOSIT_SCAN_INTERVAL_MS: "30000",
    GET_VIB_DEPOSIT_FINALITY_BLOCKS: "12",
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
    const config = loadConfig(validProductionStatic);
    expect(config.storageMode).toBe("postgres");
    expect(config.apiAuthMode).toBe("static-token");
    expect(config.databaseUrl).toMatch(/^postgres/);
  });

  it("rejects production claim manifests unless the explicit claim gate is enabled", () => {
    expect(() =>
      loadConfig({
        ...validProductionStatic,
        NETWORK_MANIFEST_JSON: JSON.stringify([
          {
            manifestVersion: 1,
            updatedAt: "2026-06-02T00:00:00.000Z",
            ttlSeconds: 600,
            id: "substrate:vibly-incentivized-testnet",
            label: "Monolith",
            stage: "testnet",
            status: "active",
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
                genesisHash: "0xabc123",
                status: "online",
                rpcUrls: ["wss://rpc.vibly.network"],
              },
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
    ).toThrow(/GET_VIB_CLAIM_ENABLED/);
  });

  it("accepts production Get VIB claim when chain and publisher are configured", () => {
    const config = loadConfig({
      ...validProductionStatic,
      GET_VIB_CLAIM_ENABLED: "true",
      GET_VIB_ROOT_UPLOAD_MODE: "unsafe-papi",
      GET_VIB_ROOT_PUBLISHER_URI: "//RootPublisher",
      NETWORK_MANIFEST_JSON: JSON.stringify([
        {
          manifestVersion: 1,
          updatedAt: "2026-06-02T00:00:00.000Z",
          ttlSeconds: 600,
          id: "substrate:vibly-incentivized-testnet",
          label: "Monolith",
          stage: "testnet",
          status: "active",
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
              genesisHash: "0xabc123",
              status: "online",
              rpcUrls: ["wss://rpc.vibly.network"],
            },
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
    });
    expect(config.getVibClaimEnabled).toBe(true);
  });

  it("rejects production network manifests with online chains missing genesis hashes", () => {
    expect(() =>
      loadConfig({
        ...validProductionStatic,
        NETWORK_MANIFEST_JSON: JSON.stringify([
          {
            manifestVersion: 1,
            updatedAt: "2026-06-02T00:00:00.000Z",
            ttlSeconds: 600,
            id: "substrate:vibly-incentivized-testnet",
            label: "Monolith",
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
