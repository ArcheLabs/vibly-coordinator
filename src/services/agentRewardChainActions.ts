import type { CoordinatorConfig } from "../config/env.js";
import type { AgentRewardLedger, RewardDifficulty } from "../contexts/reward/types.js";

export type RewardChainReceipt = {
  txHash: string;
  mode: "prepare-only" | "fixture" | "unsafe-papi";
  finality: "prepared" | "included" | "finalized";
};

export class AgentRewardChainActions {
  constructor(private readonly config: CoordinatorConfig) {}

  async settleBaseStakingDay(dayIndex: number, agents: Array<{ identityId: string; agentId: string }>): Promise<RewardChainReceipt> {
    return this.submit("settle_base_staking_day", { dayIndex, agents });
  }

  async settleObserverRound(roundId: string, dayIndex: number, participants: Array<{ identityId: string; agentId: string }>): Promise<RewardChainReceipt> {
    return this.submit("settle_observer_round", { roundId, dayIndex, participants });
  }

  async settleReviewerRound(roundId: string, dayIndex: number, participants: Array<{ identityId: string; agentId: string }>): Promise<RewardChainReceipt> {
    return this.submit("settle_reviewer_round", { roundId, dayIndex, participants });
  }

  async settleTaskReward(taskId: string, dayIndex: number, executor: { identityId: string; agentId: string }, difficulty: RewardDifficulty): Promise<RewardChainReceipt> {
    return this.submit("settle_task_reward", { taskId, dayIndex, executor, difficulty });
  }

  async claimAgentRewards(ledger: AgentRewardLedger): Promise<RewardChainReceipt> {
    return this.submit("claim_agent_rewards", { identityId: ledger.identityId, agentId: ledger.chainAgentId });
  }

  private async submit(
    call:
      | "settle_base_staking_day"
      | "settle_observer_round"
      | "settle_reviewer_round"
      | "settle_task_reward"
      | "claim_agent_rewards",
    payload: Record<string, unknown>,
  ): Promise<RewardChainReceipt> {
    const mode = this.config.substrateStakeTxMode;
    if (mode === "prepare-only") {
      return { txHash: `prepared:${call}:${Date.now().toString(16)}`, mode, finality: "prepared" };
    }
    if (mode === "fixture") {
      return { txHash: `0xreward_${call}_${Date.now().toString(16)}`, mode, finality: "included" };
    }
    return submitUnsafePapi({
      rpcUrl: this.config.substrateRpcUrl,
      signerUri: this.config.substrateCoordinatorAuthorityUri,
      call,
      payload,
    });
  }
}

async function submitUnsafePapi(input: {
  rpcUrl: string;
  signerUri: string;
  call: "settle_base_staking_day" | "settle_observer_round" | "settle_reviewer_round" | "settle_task_reward" | "claim_agent_rewards";
  payload: Record<string, unknown>;
}): Promise<RewardChainReceipt> {
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
  const { cryptoWaitReady } = cryptoModule as { cryptoWaitReady: () => Promise<void> };
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(input.rpcUrl) });
  try {
    const keyring = new Keyring({ type: "sr25519" });
    const signer = keyring.addFromUri(input.signerUri);
    const tx = buildTx(api, input.call, input.payload);
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

function buildTx(api: ChainApi, call: string, payload: Record<string, unknown>): ChainTx {
  switch (call) {
    case "settle_base_staking_day":
      return api.tx.agentIncentives.settleBaseStakingDay(
        payload["dayIndex"],
        payload["agents"],
      );
    case "settle_observer_round":
      return api.tx.agentIncentives.settleObserverRound(
        payload["roundId"],
        payload["dayIndex"],
        payload["participants"],
      );
    case "settle_reviewer_round":
      return api.tx.agentIncentives.settleReviewerRound(
        payload["roundId"],
        payload["dayIndex"],
        payload["participants"],
      );
    case "settle_task_reward":
      return api.tx.agentIncentives.settleTaskReward(
        payload["taskId"],
        payload["dayIndex"],
        payload["executor"],
        difficultyArg(String(payload["difficulty"] ?? "normal")),
      );
    case "claim_agent_rewards":
      return api.tx.agentIncentives.claimAgentRewards(payload["identityId"], payload["agentId"]);
    default:
      throw new Error(`Unsupported reward call: ${call}`);
  }
}

function difficultyArg(value: string): string | Record<string, null> {
  const normalized = value.toLowerCase();
  if (normalized === "easy") return { Easy: null };
  if (normalized === "hard") return { Hard: null };
  if (normalized === "critical") return { Critical: null };
  return { Normal: null };
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
    agentIncentives: {
      settleBaseStakingDay: (dayIndex: unknown, agents: unknown) => ChainTx;
      settleObserverRound: (roundId: unknown, dayIndex: unknown, participants: unknown) => ChainTx;
      settleReviewerRound: (roundId: unknown, dayIndex: unknown, participants: unknown) => ChainTx;
      settleTaskReward: (taskId: unknown, dayIndex: unknown, executor: unknown, difficulty: unknown) => ChainTx;
      claimAgentRewards: (identityId: unknown, agentId: unknown) => ChainTx;
    };
  };
  disconnect: () => Promise<void>;
};
