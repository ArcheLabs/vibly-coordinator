import type { CoordinatorConfig } from "../config/env.js";
import { IdentityRepository } from "../contexts/identity/repository.js";
import type { AgentProfile } from "../contexts/identity/types.js";
import {
  AGENT_REWARD_INDEXER_HEALTH_ID,
  RewardRepository,
} from "../contexts/reward/repository.js";
import type {
  AgentRewardLedger,
  RewardDayState,
  RewardDifficulty,
  TaskRewardSettlement,
} from "../contexts/reward/types.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";

type RawRewardLedger = {
  id: string;
  chainId: string;
  identityId: string;
  agentId: string;
  claimableTotal: string | number | bigint;
  claimedTotal: string | number | bigint;
  claimableBase: string | number | bigint;
  claimableObserver: string | number | bigint;
  claimableReviewer: string | number | bigint;
  claimableTask: string | number | bigint;
  claimedBase: string | number | bigint;
  claimedObserver: string | number | bigint;
  claimedReviewer: string | number | bigint;
  claimedTask: string | number | bigint;
  updatedAtBlock?: string | number | bigint | null;
};

type RawRewardDay = {
  id: string;
  chainId: string;
  dayIndex: number | string;
  baseStakingBudget: string | number | bigint;
  observerReviewerBudget: string | number | bigint;
  taskMarketBudget: string | number | bigint;
  baseStakingReleased: string | number | bigint;
  observerReviewerReleased: string | number | bigint;
  taskMarketReleased: string | number | bigint;
  rolloverBaseStaking: string | number | bigint;
  rolloverObserverReviewer: string | number | bigint;
  rolloverTaskMarket: string | number | bigint;
  baseStakingSettled: boolean;
  observerRoundsSettled: number | string;
  reviewerRoundsSettled: number | string;
  taskRewardsSettled: number | string;
  updatedAtBlock?: string | number | bigint | null;
};

type RawTaskReward = {
  id: string;
  chainId: string;
  taskId: string;
  identityId: string;
  agentId: string;
  difficulty: string;
  amount: string | number | bigint;
  dayIndex: number | string;
  blockNumber?: string | number | bigint | null;
};

type GraphQlResponse<TField extends string, TRow> = {
  data?: {
    [K in TField]?: {
      nodes?: TRow[];
      items?: TRow[];
    } | TRow[];
  };
  errors?: Array<{ message?: string }>;
};

const PAGE_SIZE = 500;

export function startAgentRewardIndexerSync(input: {
  config: CoordinatorConfig;
  store: CoordinatorStorePort;
}): () => void {
  if (!input.config.substrateIndexerUrl || input.config.agentStakeSyncIntervalMs <= 0) return () => {};

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const counts = await syncAgentRewards(input);
      await recordIndexerHealth(input.store, {
        ok: true,
        sourceUrl: input.config.substrateIndexerUrl,
        ...counts,
      });
    } catch (err) {
      await recordIndexerHealth(input.store, {
        ok: false,
        sourceUrl: input.config.substrateIndexerUrl,
        error: err,
      });
      console.error("[AgentRewardIndexerSync]", err);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => { void tick(); }, input.config.agentStakeSyncIntervalMs);
  return () => clearInterval(timer);
}

async function syncAgentRewards(input: {
  config: CoordinatorConfig;
  store: CoordinatorStorePort;
}): Promise<{ ledgerCount: number; rewardDayCount: number; taskRewardCount: number }> {
  const [ledgers, rewardDays, taskRewards, profiles] = await Promise.all([
    fetchAll<"agentRewardLedgers", RawRewardLedger>(input.config.substrateIndexerUrl!, "agentRewardLedgers", `nodes {
      id chainId identityId agentId claimableTotal claimedTotal claimableBase claimableObserver
      claimableReviewer claimableTask claimedBase claimedObserver claimedReviewer claimedTask updatedAtBlock
    }`, "UPDATED_AT_BLOCK_DESC"),
    fetchAll<"rewardDayStates", RawRewardDay>(input.config.substrateIndexerUrl!, "rewardDayStates", `nodes {
      id chainId dayIndex baseStakingBudget observerReviewerBudget taskMarketBudget
      baseStakingReleased observerReviewerReleased taskMarketReleased
      rolloverBaseStaking rolloverObserverReviewer rolloverTaskMarket
      baseStakingSettled observerRoundsSettled reviewerRoundsSettled taskRewardsSettled updatedAtBlock
    }`, "DAY_INDEX_DESC"),
    fetchAll<"taskRewardSettlements", RawTaskReward>(input.config.substrateIndexerUrl!, "taskRewardSettlements", `nodes {
      id chainId taskId identityId agentId difficulty amount dayIndex blockNumber
    }`, "BLOCK_NUMBER_DESC"),
    new IdentityRepository(input.store).listAgentProfiles(),
  ]);

  const repo = new RewardRepository(input.store);
  const indexedAt = new Date().toISOString();

  for (const raw of ledgers) {
    const profile = findProfileForChainRef(profiles, raw.chainId, raw.identityId, raw.agentId);
    const ledger: AgentRewardLedger = {
      id: raw.id,
      chainId: raw.chainId,
      identityId: raw.identityId,
      chainAgentId: raw.agentId,
      principalId: profile?.principalId,
      claimableTotal: String(raw.claimableTotal ?? "0"),
      claimedTotal: String(raw.claimedTotal ?? "0"),
      claimableBase: String(raw.claimableBase ?? "0"),
      claimableObserver: String(raw.claimableObserver ?? "0"),
      claimableReviewer: String(raw.claimableReviewer ?? "0"),
      claimableTask: String(raw.claimableTask ?? "0"),
      claimedBase: String(raw.claimedBase ?? "0"),
      claimedObserver: String(raw.claimedObserver ?? "0"),
      claimedReviewer: String(raw.claimedReviewer ?? "0"),
      claimedTask: String(raw.claimedTask ?? "0"),
      updatedAtBlock: raw.updatedAtBlock == null ? undefined : String(raw.updatedAtBlock),
      indexedAt,
    };
    await repo.saveLedger(ledger);
  }

  for (const raw of rewardDays) {
    const day: RewardDayState = {
      id: raw.id,
      chainId: raw.chainId,
      dayIndex: Number(raw.dayIndex),
      baseStakingBudget: String(raw.baseStakingBudget ?? "0"),
      observerReviewerBudget: String(raw.observerReviewerBudget ?? "0"),
      taskMarketBudget: String(raw.taskMarketBudget ?? "0"),
      baseStakingReleased: String(raw.baseStakingReleased ?? "0"),
      observerReviewerReleased: String(raw.observerReviewerReleased ?? "0"),
      taskMarketReleased: String(raw.taskMarketReleased ?? "0"),
      rolloverBaseStaking: String(raw.rolloverBaseStaking ?? "0"),
      rolloverObserverReviewer: String(raw.rolloverObserverReviewer ?? "0"),
      rolloverTaskMarket: String(raw.rolloverTaskMarket ?? "0"),
      baseStakingSettled: Boolean(raw.baseStakingSettled),
      observerRoundsSettled: Number(raw.observerRoundsSettled ?? 0),
      reviewerRoundsSettled: Number(raw.reviewerRoundsSettled ?? 0),
      taskRewardsSettled: Number(raw.taskRewardsSettled ?? 0),
      updatedAtBlock: raw.updatedAtBlock == null ? undefined : String(raw.updatedAtBlock),
      indexedAt,
    };
    await repo.saveRewardDay(day);
  }

  for (const raw of taskRewards) {
    const profile = findProfileForChainRef(profiles, raw.chainId, raw.identityId, raw.agentId);
    const settlement: TaskRewardSettlement = {
      id: raw.taskId,
      chainId: raw.chainId,
      taskId: raw.taskId,
      identityId: raw.identityId,
      chainAgentId: raw.agentId,
      principalId: profile?.principalId,
      difficulty: normalizeDifficulty(raw.difficulty),
      amount: String(raw.amount ?? "0"),
      dayIndex: Number(raw.dayIndex),
      blockNumber: raw.blockNumber == null ? undefined : String(raw.blockNumber),
      indexedAt,
    };
    await repo.saveTaskRewardSettlement(settlement);
  }

  return {
    ledgerCount: ledgers.length,
    rewardDayCount: rewardDays.length,
    taskRewardCount: taskRewards.length,
  };
}

async function fetchAll<TField extends string, TRow>(
  indexerUrl: string,
  field: TField,
  nodeSelection: string,
  orderBy: string,
): Promise<TRow[]> {
  const all: TRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await fetchPage<TField, TRow>(indexerUrl, field, nodeSelection, orderBy, offset, PAGE_SIZE);
    all.push(...page);
    if (page.length < PAGE_SIZE) return all;
  }
}

async function fetchPage<TField extends string, TRow>(
  indexerUrl: string,
  field: TField,
  nodeSelection: string,
  orderBy: string,
  offset: number,
  first: number,
): Promise<TRow[]> {
  const query = `query RewardSync($first: Int!, $offset: Int!) {
    ${field}(first: $first, offset: $offset, orderBy: ${orderBy}) {
      nodes { ${nodeSelection.replace(/^nodes\s*{|\}$/g, "").trim()} }
    }
  }`;
  const body = await postGraphQl<TField, TRow>(indexerUrl, query, { first, offset });
  const value = body.data?.[field];
  if (Array.isArray(value)) return value;
  return value?.nodes ?? value?.items ?? [];
}

async function postGraphQl<TField extends string, TRow>(
  indexerUrl: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphQlResponse<TField, TRow>> {
  const fetchOptions = {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  };
  let response: Response;
  try {
    response = await fetch(indexerUrl, fetchOptions);
  } catch {
    response = await fetch(indexerUrl, fetchOptions);
  }
  if (!response.ok) throw new Error(`AgentReward GraphQL request failed: HTTP ${response.status}`);
  const body = await response.json() as GraphQlResponse<TField, TRow>;
  if (body.errors?.length) {
    throw new Error(`AgentReward GraphQL error: ${body.errors.map((err) => err.message ?? "unknown").join("; ")}`);
  }
  return body;
}

async function recordIndexerHealth(
  store: CoordinatorStorePort,
  input:
    | { ok: true; sourceUrl?: string; ledgerCount: number; rewardDayCount: number; taskRewardCount: number }
    | { ok: false; sourceUrl?: string; error: unknown },
): Promise<void> {
  const repo = new RewardRepository(store);
  const previous = await repo.getIndexerHealth();
  const now = new Date().toISOString();
  if (input.ok) {
    await repo.saveIndexerHealth({
      id: AGENT_REWARD_INDEXER_HEALTH_ID,
      status: "healthy",
      sourceUrl: input.sourceUrl,
      lastAttemptAt: now,
      lastSuccessfulSyncAt: now,
      lastErrorAt: previous?.lastErrorAt,
      lastError: previous?.lastError,
      consecutiveFailures: 0,
      ledgerCount: input.ledgerCount,
      rewardDayCount: input.rewardDayCount,
      taskRewardCount: input.taskRewardCount,
    });
    return;
  }

  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  await repo.saveIndexerHealth({
    id: AGENT_REWARD_INDEXER_HEALTH_ID,
    status: consecutiveFailures >= 3 ? "down" : "degraded",
    sourceUrl: input.sourceUrl,
    lastAttemptAt: now,
    lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt,
    lastErrorAt: now,
    lastError: input.error instanceof Error ? input.error.message : String(input.error),
    consecutiveFailures,
    ledgerCount: previous?.ledgerCount ?? 0,
    rewardDayCount: previous?.rewardDayCount ?? 0,
    taskRewardCount: previous?.taskRewardCount ?? 0,
  });
}

function findProfileForChainRef(
  profiles: AgentProfile[],
  chainId: string,
  identityId: string,
  agentId: string,
): AgentProfile | undefined {
  return profiles.find((profile) =>
    profile.chainId === chainId &&
    profile.identityId === identityId &&
    profile.chainAgentId === agentId,
  );
}

function normalizeDifficulty(value: string): RewardDifficulty {
  const normalized = value.toLowerCase();
  if (normalized === "easy" || normalized === "normal" || normalized === "hard" || normalized === "critical") {
    return normalized;
  }
  return "normal";
}
