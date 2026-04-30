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
});
