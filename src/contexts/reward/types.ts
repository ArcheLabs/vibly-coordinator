export type RewardDifficulty = "easy" | "normal" | "hard" | "critical";

export interface AgentRewardLedger {
  id: string;
  chainId: string;
  identityId: string;
  chainAgentId: string;
  principalId?: string;
  claimableTotal: string;
  claimedTotal: string;
  claimableBase: string;
  claimableObserver: string;
  claimableReviewer: string;
  claimableTask: string;
  claimedBase: string;
  claimedObserver: string;
  claimedReviewer: string;
  claimedTask: string;
  updatedAtBlock?: string;
  indexedAt: string;
}

export interface RewardDayState {
  id: string;
  chainId: string;
  dayIndex: number;
  baseStakingBudget: string;
  observerReviewerBudget: string;
  taskMarketBudget: string;
  baseStakingReleased: string;
  observerReviewerReleased: string;
  taskMarketReleased: string;
  rolloverBaseStaking: string;
  rolloverObserverReviewer: string;
  rolloverTaskMarket: string;
  baseStakingSettled: boolean;
  observerRoundsSettled: number;
  reviewerRoundsSettled: number;
  taskRewardsSettled: number;
  updatedAtBlock?: string;
  indexedAt: string;
}

export interface RoundRewardSettlement {
  id: string;
  chainId: string;
  roundId: string;
  role: "observer" | "reviewer";
  dayIndex: number;
  participantCount: number;
  totalEffectiveStake: string;
  released: string;
  rollover: string;
  blockNumber?: string;
  indexedAt: string;
}

export interface TaskRewardSettlement {
  id: string;
  chainId: string;
  taskId: string;
  identityId: string;
  chainAgentId: string;
  principalId?: string;
  difficulty: RewardDifficulty;
  amount: string;
  dayIndex: number;
  blockNumber?: string;
  indexedAt: string;
}

export interface TaskRewardSuggestion {
  id: string;
  taskId: string;
  observerId: string;
  difficulty: RewardDifficulty;
  rationale?: string;
  status: "pending" | "approved" | "superseded";
  createdAt: string;
  updatedAt: string;
}

export interface TaskRewardApproval {
  id: string;
  taskId: string;
  approvedTaskRewardSuggestionId: string;
  difficulty: RewardDifficulty;
  approvedBy: string;
  status: "approved";
  createdAt: string;
  updatedAt: string;
}

export type AgentRewardIndexerHealthStatus = "healthy" | "degraded" | "down";

export interface AgentRewardIndexerHealth {
  id: "agent-reward-indexer";
  status: AgentRewardIndexerHealthStatus;
  sourceUrl?: string;
  lastAttemptAt: string;
  lastSuccessfulSyncAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  ledgerCount: number;
  rewardDayCount: number;
  taskRewardCount: number;
}
