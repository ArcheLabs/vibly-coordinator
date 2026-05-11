export type RewardStatus = "pending" | "approved" | "settled" | "failed" | "vetoed";

export interface RewardIntent {
  id: string;
  organizationId: string;
  /** Reason for the reward (e.g. task completed, proposal accepted). */
  reason: string;
  recipientId: string;
  amount: string;
  currency: string;
  sourceRef: { type: string; id: string };
  status: RewardStatus;
  guardianVetoDeadline?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SettlementBatch {
  id: string;
  organizationId: string;
  rewardIntentIds: string[];
  totalAmount: string;
  currency: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  txHash?: string;
  submittedAt?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}
