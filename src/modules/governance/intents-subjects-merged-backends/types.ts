import type { GovernanceBackendDescriptor, GovernanceCheckpointView } from "@concord/governance";
import type { ChainRef, TxReceipt } from "@concord/core";

export type GovernanceBackendHealthStatus = "healthy" | "stale" | "unavailable";

export interface GovernanceBackendHealth {
  status: GovernanceBackendHealthStatus;
  stale: boolean;
  reason?: string;
  lastObservedAt?: string;
  checkpoint?: GovernanceCheckpointView;
}

export type GovernanceBackendReadModel = GovernanceBackendDescriptor & {
  health: GovernanceBackendHealth;
};

export interface GovernanceTxReceiptProjection {
  id: string;
  intentId?: string;
  subjectId?: string;
  action: "submitProposal" | "castVote";
  backend: "substrate-opengov";
  chain: ChainRef;
  actor: string;
  tx: TxReceipt;
  payloadSummary?: Record<string, unknown>;
  readbackStatus: "pending_indexer" | "linked" | "failed";
  createdAt: string;
  updatedAt: string;
}
