/**
 * Utilities for building GovernanceMergedView at query time.
 *
 * A merged view joins:
 *   - A governance intent (coordination layer, optional)
 *   - A governance subject view (chain layer, optional)
 *   - A GovernanceIntentChainLink (the explicit join record, optional)
 *   - Votes + delegations for the subject (optional)
 *   - The latest checkpoint (freshness info)
 */

import type {
  GovernanceMergedView,
  GovernanceMergedStatus,
  GovernanceSubjectView,
  GovernanceVoteActivityView,
  GovernanceDelegationView,
  GovernanceCheckpointView,
  GovernanceIntentChainLink,
} from "@vibly-ai/concord-governance";

/** How old the checkpoint can be before we consider the view stale (ms). */
export const GOVERNANCE_STALE_THRESHOLD_MS = Number(
  process.env["GOVERNANCE_STALE_THRESHOLD_MS"] ?? "60000",
);

export interface BuildMergedViewInput {
  id: string;
  projectId?: string;
  intent?: {
    id: string;
    title?: string;
    status?: string;
    proposedBy?: string;
    createdAt?: string;
  };
  subject?: GovernanceSubjectView;
  votes?: GovernanceVoteActivityView[];
  delegations?: GovernanceDelegationView[];
  link?: GovernanceIntentChainLink;
  checkpoint?: GovernanceCheckpointView;
}

export function buildMergedView(input: BuildMergedViewInput): GovernanceMergedView {
  const { id, projectId, intent, subject, votes, delegations, link, checkpoint } = input;

  const coordinationStatus = intent?.status;
  const chainStatus = subject?.status;
  const stale = isCheckpointStale(checkpoint);
  const merged = computeMergedStatus(coordinationStatus, chainStatus, stale);

  return {
    id,
    projectId,
    intent,
    subject,
    votes,
    delegations,
    link,
    status: {
      coordination: coordinationStatus,
      chain: chainStatus,
      merged,
    },
    freshness: {
      checkpoint,
      lastIndexedAt: checkpoint?.observedAt,
      stale,
      reason: stale ? "checkpoint_age_exceeds_threshold" : undefined,
    },
  };
}

export function computeMergedStatus(
  coordinationStatus?: string,
  chainStatus?: string,
  stale?: boolean,
): GovernanceMergedStatus {
  if (!chainStatus) {
    return "not_submitted";
  }

  const activeStatuses = new Set(["Submitted", "Deciding", "Confirming"]);
  const approvedStatuses = new Set(["Approved", "Executed"]);
  const failedStatuses = new Set(["Rejected", "Cancelled", "TimedOut", "Killed"]);

  if (approvedStatuses.has(chainStatus)) return "approved_on_chain";
  if (failedStatuses.has(chainStatus)) return "failed_on_chain";
  if (activeStatuses.has(chainStatus)) return "active_on_chain";

  if (stale) return "stale";
  return "unknown";
}

export function isCheckpointStale(
  checkpoint?: GovernanceCheckpointView,
  thresholdMs: number = GOVERNANCE_STALE_THRESHOLD_MS,
): boolean {
  if (!checkpoint) return false;
  const age = Date.now() - new Date(checkpoint.observedAt).getTime();
  return age > thresholdMs;
}
