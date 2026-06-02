import { afterEach, describe, expect, it, vi } from "vitest";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { loadConfig } from "../config/env.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import { IdentityRepository } from "../contexts/identity/repository.js";
import { normalizeSubstrateAccount, syncChainRootIdentities } from "./chainIdentityIndexerSync.js";

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
    async createLease() {
      throw new Error("not implemented");
    },
    async tryAcquireLease() {
      return undefined;
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

describe("chain identity indexer sync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("syncs indexed root identities by normalized owner account", async () => {
    await cryptoWaitReady();
    const owner = new Keyring({ type: "sr25519" }).addFromUri("//Alice").address;
    const store = makeStore();
    const config = loadConfig({
      NODE_ENV: "test",
      SUBSTRATE_INDEXER_URL: "http://indexer.test/graphql",
      SUBSTRATE_CHAIN_ID: "substrate:vibly-solo",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: {
        chainIdentities: {
          nodes: [
            {
              id: "substrate:vibly-solo:0xidentity",
              chainId: "substrate:vibly-solo",
              identityId: "0xidentity",
              owner,
              status: "Active",
              createdAtBlock: "10",
              updatedAtBlock: "10",
            },
          ],
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(syncChainRootIdentities(config, store)).resolves.toBe(1);
    const identity = await new IdentityRepository(store).getChainRootIdentity(config.substrateChainId, normalizeSubstrateAccount(owner));

    expect(identity).toMatchObject({
      chainId: "substrate:vibly-solo",
      identityId: "0xidentity",
      ownerAddress: owner,
      status: "active",
      updatedAtBlock: "10",
    });
  });
});
