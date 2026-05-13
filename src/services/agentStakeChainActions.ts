import type { CoordinatorConfig } from "../config/env.js";
import type { AgentStakeLedger } from "../contexts/stake/types.js";

export type StakeChainReceipt = {
  txHash: string;
  mode: "prepare-only" | "fixture" | "unsafe-papi";
  finality: "prepared" | "included" | "finalized";
};

export class AgentStakeChainActions {
  constructor(private readonly config: CoordinatorConfig) {}

  async blockRelease(ledger: AgentStakeLedger, reasonRef?: string): Promise<StakeChainReceipt> {
    return this.submit("block_release", ledger, reasonRef);
  }

  async clearReleaseBlock(ledger: AgentStakeLedger): Promise<StakeChainReceipt> {
    return this.submit("clear_release_block", ledger);
  }

  private async submit(call: "block_release" | "clear_release_block", ledger: AgentStakeLedger, reasonRef?: string): Promise<StakeChainReceipt> {
    const mode = this.config.substrateStakeTxMode;
    if (mode === "prepare-only") {
      return {
        txHash: `prepared:${call}:${ledger.id}`,
        mode,
        finality: "prepared",
      };
    }
    if (mode === "fixture") {
      return {
        txHash: `0xstake_${call}_${Date.now().toString(16)}`,
        mode,
        finality: "included",
      };
    }
    return submitUnsafePapi({
      rpcUrl: this.config.substrateRpcUrl,
      signerUri: this.config.substrateCoordinatorAuthorityUri,
      chainId: this.config.substrateChainId,
      call,
      identityId: ledger.identityId,
      agentId: ledger.chainAgentId,
      reasonRef,
    });
  }
}

async function submitUnsafePapi(input: {
  rpcUrl: string;
  signerUri: string;
  chainId: string;
  call: "block_release" | "clear_release_block";
  identityId: string;
  agentId: string;
  reasonRef?: string;
}): Promise<StakeChainReceipt> {
  const [apiModule, keyringModule, cryptoModule] = await Promise.all([
    dynamicImport("@polkadot/api"),
    dynamicImport("@polkadot/keyring"),
    dynamicImport("@polkadot/util-crypto"),
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
  const api = await ApiPromise.create({ provider: new WsProvider(input.rpcUrl) });
  try {
    const keyring = new Keyring({ type: "sr25519" });
    const signer = keyring.addFromUri(input.signerUri);
    const tx = input.call === "block_release"
      ? api.tx.agentStaking.blockRelease(input.identityId, input.agentId, input.reasonRef ? { Uri: input.reasonRef } : null)
      : api.tx.agentStaking.clearReleaseBlock(input.identityId, input.agentId);
    const txHash = await new Promise<string>((resolve, reject) => {
      void tx.signAndSend(signer, (result) => {
        if (result.dispatchError) {
          reject(new Error(result.dispatchError.toString()));
          return;
        }
        if (result.status.isInBlock || result.status.isFinalized) {
          resolve(tx.hash.toHex());
        }
      }).catch(reject);
    });
    return { txHash, mode: "unsafe-papi", finality: "included" };
  } finally {
    await api.disconnect();
  }
}

function dynamicImport(specifier: string): Promise<Record<string, unknown>> {
  const loader = new Function("specifier", "return import(specifier)") as (value: string) => Promise<Record<string, unknown>>;
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
    agentStaking: {
      blockRelease: (identityId: string, agentId: string, reasonRef: { Uri: string } | null) => ChainTx;
      clearReleaseBlock: (identityId: string, agentId: string) => ChainTx;
    };
  };
  disconnect: () => Promise<void>;
};
