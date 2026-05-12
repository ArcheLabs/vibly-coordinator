export type AgentStakeStatus = "active" | "unbonding" | "released" | "missing" | "stale";

export interface AgentStakeLedger {
  id: string;
  chainId: string;
  identityId: string;
  chainAgentId: string;
  principalId?: string;
  fundingAccount?: string;
  activeAmount: string;
  unbondingAmount: string;
  status: AgentStakeStatus;
  unlockAtBlock?: string;
  releaseBlocked: boolean;
  releaseBlockReason?: string;
  updatedAtBlock?: string;
  indexedAt: string;
}
