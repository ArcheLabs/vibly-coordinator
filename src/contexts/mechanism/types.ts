/**
 * Mechanism context — coordination mechanism types and engine.
 *
 * Mechanisms are declarative data that the Coordinator interprets.
 * No user-uploaded code is executed.
 *
 * Uses @concord/policy, @concord/selection, @concord/reputation where
 * available; falls back to simple built-in logic otherwise.
 */

export type MechanismPrimitive =
  | "random-selection"
  | "stake-weighted-selection"
  | "reputation-weighted-selection"
  | "majority-vote"
  | "supermajority-vote"
  | "single-approver"
  | "unanimous-vote";

export interface SelectionRule {
  primitive: MechanismPrimitive;
  count?: number;
  pool?: "all-members" | "active-members" | "role-filtered";
  roleFilter?: string;
  minReputation?: number;
  minStake?: string;
}

export interface TimeoutRule {
  durationMs: number;
  action: "skip" | "select-backup" | "cancel" | "escalate";
}

export interface RewardRule {
  base?: string;
  bonusFormula?: string;
  reputationDelta?: number;
  penaltyOnFailure?: number;
}

export interface CoordinationMechanism {
  id: string;
  organizationId: string;
  projectId?: string;
  name: string;
  description?: string;
  /** How observers are selected for ObservationTasks. */
  observerSelection?: SelectionRule;
  /** How discussion participants are selected. */
  participantSelection?: SelectionRule;
  /** How reviewers are selected for ReviewRounds. */
  reviewerSelection?: SelectionRule;
  /** How voters are selected for VotingRounds. */
  voterSelection?: SelectionRule;
  /** How tasks are assigned. */
  assignmentSelection?: SelectionRule;
  /** Timeout rules for assignments and observations. */
  timeout?: TimeoutRule;
  /** Reward and reputation rules. */
  reward?: RewardRule;
  /** Voting decision rule. */
  votingRule?: MechanismPrimitive;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
