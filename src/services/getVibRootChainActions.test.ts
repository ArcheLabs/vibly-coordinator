import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/env.js";
import { GetVibRootChainActions } from "./getVibRootChainActions.js";
import type { AllocationManifest } from "../modules/conversion/get-vib/domain.js";

const manifest: AllocationManifest = {
  networkId: "substrate:vibly-solo",
  rootVersion: 7,
  saleRuleVersion: "conversion-v1",
  merkleRoot: `0x${"11".repeat(32)}`,
  metadataHash: `0x${"22".repeat(32)}`,
  totalCumulativeAmount: "123.45",
  allocations: [],
  deposits: [],
  createdAt: "2026-06-01T00:00:00.000Z",
};

function config(mode: "prepare-only" | "fixture" | "unsafe-papi") {
  return loadConfig({
    NODE_ENV: "test",
    GET_VIB_ROOT_UPLOAD_MODE: mode,
    GET_VIB_ROOT_PUBLISHER_URI: "//RootPublisher",
    SUBSTRATE_RPC_URL: "ws://chain.local",
    SUBSTRATE_COORDINATOR_AUTHORITY_URI: "//Alice",
  });
}

describe("GetVibRootChainActions", () => {
  it("returns a prepare-only receipt", async () => {
    const receipt = await new GetVibRootChainActions(config("prepare-only")).submitClaimRoot(manifest);

    expect(receipt).toMatchObject({ mode: "prepare-only", finality: "prepared" });
    expect(receipt.txHash).toContain("prepared:vib_claim:set_claim_root");
  });

  it("returns a fixture receipt", async () => {
    const receipt = await new GetVibRootChainActions(config("fixture")).submitClaimRoot(manifest);

    expect(receipt).toMatchObject({ mode: "fixture", finality: "included" });
    expect(receipt.txHash).toContain("0xvibclaim_");
  });

  it("submits setClaimRoot directly with publisher hot key in unsafe-papi mode", async () => {
    const tx = {
      hash: { toHex: () => "0xroot" },
      signAndSend: vi.fn(async (_signer: unknown, callback: (result: { status: { isInBlock: boolean; isFinalized: boolean } }) => void) => {
        callback({ status: { isInBlock: true, isFinalized: false } });
        return () => undefined;
      }),
    };
    const disconnect = vi.fn(async () => undefined);
    const setClaimRoot = vi.fn(() => tx);
    const addFromUri = vi.fn(() => "publisher-signer");
    const cryptoWaitReady = vi.fn(async () => undefined);
    const create = vi.fn(async () => ({ tx: { vibClaim: { setClaimRoot } }, disconnect }));
    const WsProvider = vi.fn(function WsProvider(this: unknown, _rpcUrl: string) { return this; });
    const Keyring = vi.fn(function Keyring(this: { addFromUri: typeof addFromUri }) { this.addFromUri = addFromUri; });
    const loader = vi.fn(async (specifier: string): Promise<Record<string, unknown>> => {
      if (specifier === "@polkadot/api") return { ApiPromise: { create }, WsProvider };
      if (specifier === "@polkadot/keyring") return { Keyring };
      if (specifier === "@polkadot/util-crypto") return { cryptoWaitReady };
      throw new Error(`unexpected import ${specifier}`);
    });

    const receipt = await new GetVibRootChainActions(config("unsafe-papi"), loader).submitClaimRoot(manifest);

    expect(receipt).toEqual({ txHash: "0xroot", mode: "unsafe-papi", finality: "included" });
    expect(cryptoWaitReady).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(addFromUri).toHaveBeenCalledWith("//RootPublisher");
    expect(setClaimRoot).toHaveBeenCalledWith(
      "substrate:vibly-solo",
      7,
      manifest.merkleRoot,
      "123450000000000",
      manifest.metadataHash,
    );
    expect(tx.signAndSend).toHaveBeenCalledWith("publisher-signer", expect.any(Function));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
