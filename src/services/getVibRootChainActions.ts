import type { CoordinatorConfig } from "../config/env.js";
import { badRequest, upgradeRequired } from "../domain/errors.js";
import type { AllocationManifest, ClaimProof } from "../modules/conversion/get-vib/domain.js";
import { getVibAmountToBaseUnits } from "../modules/conversion/get-vib/domain.js";

export type GetVibRootUploadMode = "prepare-only" | "fixture" | "unsafe-papi";

export type GetVibRootReceipt = {
  txHash: string;
  mode: GetVibRootUploadMode;
  finality: "prepared" | "included" | "finalized";
};

type DynamicLoader = (specifier: string) => Promise<Record<string, unknown>>;

export class GetVibRootChainActions {
  constructor(
    private readonly config: CoordinatorConfig,
    private readonly loadModule: DynamicLoader = dynamicImport,
  ) {}

  async submitClaimRoot(manifest: AllocationManifest): Promise<GetVibRootReceipt> {
    const mode = this.config.getVibRootUploadMode;
    if (mode === "prepare-only") {
      return {
        txHash: `prepared:vib_claim:set_claim_root:${manifest.networkId}:${manifest.rootVersion}`,
        mode,
        finality: "prepared",
      };
    }
    if (mode === "fixture") {
      return {
        txHash: `0xvibclaim_${manifest.networkId.replace(/[^a-zA-Z0-9]/g, "_")}_${manifest.rootVersion}_${Date.now().toString(16)}`,
        mode,
        finality: "included",
      };
    }
    return submitUnsafePapi({
      config: this.config,
      tx: buildSetClaimRootTx(manifest),
      loadModule: this.loadModule,
    });
  }

  async claimFor(proof: ClaimProof): Promise<GetVibRootReceipt> {
    const mode = this.config.getVibRootUploadMode;
    if (mode === "prepare-only") {
      return {
        txHash: `prepared:vib_claim:claim_for:${proof.networkId}:${proof.rootVersion}:${proof.accountId}`,
        mode,
        finality: "prepared",
      };
    }
    if (mode === "fixture") {
      return {
        txHash: `0xvibclaim_for_${proof.networkId.replace(/[^a-zA-Z0-9]/g, "_")}_${proof.rootVersion}_${Date.now().toString(16)}`,
        mode,
        finality: "included",
      };
    }
    return submitUnsafePapi({
      config: this.config,
      tx: buildClaimForTx(proof),
      loadModule: this.loadModule,
    });
  }
}

async function submitUnsafePapi(input: {
  config: CoordinatorConfig;
  tx: (api: ChainApi) => ChainTx;
  loadModule: DynamicLoader;
}): Promise<GetVibRootReceipt> {
  const publisherUri = input.config.getVibRootPublisherUri?.trim();
  if (!publisherUri) {
    throw badRequest("GET_VIB_ROOT_PUBLISHER_URI is required for GET_VIB_ROOT_UPLOAD_MODE=unsafe-papi");
  }

  const [apiModule, keyringModule, cryptoModule] = await Promise.all([
    input.loadModule("@polkadot/api"),
    input.loadModule("@polkadot/keyring"),
    input.loadModule("@polkadot/util-crypto"),
  ]);
  const { ApiPromise, WsProvider } = apiModule as {
    ApiPromise: { create: (options: { provider: unknown }) => Promise<ChainApi> };
    WsProvider: new (rpcUrl: string) => unknown;
  };
  const { Keyring } = keyringModule as {
    Keyring: new (options: { type: "sr25519" }) => { addFromUri: (uri: string) => unknown };
  };
  const { cryptoWaitReady } = cryptoModule as {
    cryptoWaitReady: () => Promise<void>;
  };

  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(input.config.substrateRpcUrl) });
  try {
    const keyring = new Keyring({ type: "sr25519" });
    const signer = keyring.addFromUri(publisherUri);
    const tx = input.tx(api);
    const txHash = await new Promise<string>((resolve, reject) => {
      void tx.signAndSend(signer, (result) => {
        if (result.dispatchError) {
          reject(new Error(result.dispatchError.toString()));
          return;
        }
        if (result.status.isFinalized || result.status.isInBlock) {
          resolve(tx.hash.toHex());
        }
      }).catch(reject);
    });
    return { txHash, mode: "unsafe-papi", finality: "included" };
  } finally {
    await api.disconnect();
  }
}

function buildSetClaimRootTx(manifest: AllocationManifest): (api: ChainApi) => ChainTx {
  return (api) => {
    if (!api.tx.vibClaim?.setClaimRoot) {
      throw upgradeRequired("Connected Vibly chain runtime does not expose vibClaim.setClaimRoot. Rebuild and restart the chain node.");
    }
    return api.tx.vibClaim.setClaimRoot(
      manifest.networkId,
      manifest.rootVersion,
      manifest.merkleRoot,
      getVibAmountToBaseUnits(manifest.totalCumulativeAmount),
      manifest.metadataHash,
    );
  };
}

function buildClaimForTx(proof: ClaimProof): (api: ChainApi) => ChainTx {
  return (api) => {
    if (!api.tx.vibClaim?.claimFor) {
      throw upgradeRequired("Connected Vibly chain runtime does not expose vibClaim.claimFor. Rebuild and restart the chain node.");
    }
    return api.tx.vibClaim.claimFor(
      proof.accountId,
      proof.networkId,
      proof.rootVersion,
      proof.identityId ?? "",
      getVibAmountToBaseUnits(proof.cumulativeAmount),
      proof.proof.map((item) => ({
        position: item.position === "left" ? "Left" : "Right",
        hash: item.hash,
      })),
    );
  };
}

function dynamicImport(specifier: string): Promise<Record<string, unknown>> {
  const loader = new Function("specifier", "return import(specifier)") as DynamicLoader;
  return loader(specifier);
}

type ChainTx = {
  hash: { toHex: () => string };
  signAndSend: (
    signer: unknown,
    callback: (result: {
      dispatchError?: { toString: () => string };
      status: { isInBlock: boolean; isFinalized: boolean };
    }) => void,
  ) => Promise<() => void>;
};

type ChainApi = {
  tx: {
    vibClaim: {
      setClaimRoot?: (
        networkId: string,
        rootVersion: number,
        merkleRoot: string,
        totalCumulativeAmount: string,
        metadataHash: string,
      ) => ChainTx;
      claimFor?: (
        accountId: string,
        networkId: string,
        rootVersion: number,
        identityId: string,
        cumulativeAmount: string,
        proof: Array<{ position: "Left" | "Right"; hash: string }>,
      ) => ChainTx;
    };
  };
  disconnect: () => Promise<void>;
};
