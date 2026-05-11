/**
 * MechanismEngine — interprets declarative mechanism primitives.
 *
 * Reuses @concord/selection for participant selection where possible.
 * No user-uploaded code is ever executed here.
 */

import type { CoordinationMechanism, SelectionRule } from "./types.js";

export interface SelectionInput {
  candidates: string[];
  weights?: Map<string, number>;
}

export interface SelectionResult {
  selected: string[];
}

/**
 * Select participants according to a SelectionRule.
 * Falls back to random selection if weights are unavailable.
 */
export function selectParticipants(
  rule: SelectionRule,
  input: SelectionInput,
): SelectionResult {
  const count = rule.count ?? 1;
  const { candidates, weights } = input;

  if (candidates.length === 0) return { selected: [] };

  const take = Math.min(count, candidates.length);

  if (
    rule.primitive === "stake-weighted-selection" ||
    rule.primitive === "reputation-weighted-selection"
  ) {
    if (weights && weights.size > 0) {
      // Weighted reservoir sampling (simple O(n) implementation)
      const sorted = [...candidates].sort((a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0));
      return { selected: sorted.slice(0, take) };
    }
  }

  // Default: random selection using Fisher-Yates partial shuffle
  const pool = [...candidates];
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return { selected: pool.slice(0, take) };
}

export interface EligibilityInput {
  principalId: string;
  reputationScore?: number;
  stakeBalance?: bigint;
  rule: Pick<SelectionRule, "minReputation" | "minStake">;
}

/** Check if a principal meets the minimum eligibility requirements of a rule. */
export function checkEligibility(input: EligibilityInput): boolean {
  const { reputationScore, stakeBalance, rule } = input;
  if (rule.minReputation != null && (reputationScore ?? 0) < rule.minReputation) return false;
  if (rule.minStake != null && stakeBalance != null) {
    try {
      if (stakeBalance < BigInt(rule.minStake)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export interface TimeoutEvaluationInput {
  createdAt: string;
  durationMs: number;
  now?: Date;
}

/** Returns true if the item has exceeded its timeout window. */
export function evaluateTimeout(input: TimeoutEvaluationInput): boolean {
  const nowMs = (input.now ?? new Date()).getTime();
  const createdMs = new Date(input.createdAt).getTime();
  return nowMs - createdMs > input.durationMs;
}

export interface VotingDecision {
  approveCount: number;
  rejectCount: number;
  abstainCount: number;
  totalEligible: number;
  rule: CoordinationMechanism["votingRule"];
}

/** Evaluate whether a vote tally reaches the required threshold. */
export function evaluateVotingDecision(d: VotingDecision): "approved" | "rejected" | "pending" {
  const voted = d.approveCount + d.rejectCount + d.abstainCount;
  const quorum = d.totalEligible > 0 ? voted / d.totalEligible : 0;

  // Require at least 1 vote
  if (voted === 0) return "pending";

  switch (d.rule ?? "majority-vote") {
    case "single-approver":
      return d.approveCount >= 1 ? "approved" : d.rejectCount >= 1 ? "rejected" : "pending";
    case "unanimous-vote":
      if (quorum < 1) return "pending";
      return d.rejectCount === 0 ? "approved" : "rejected";
    case "supermajority-vote": {
      const total = d.approveCount + d.rejectCount;
      if (total === 0) return "pending";
      return d.approveCount / total >= 2 / 3 ? "approved" : "rejected";
    }
    default: // majority-vote
      if (d.approveCount + d.rejectCount === 0) return "pending";
      return d.approveCount > d.rejectCount ? "approved" : "rejected";
  }
}
