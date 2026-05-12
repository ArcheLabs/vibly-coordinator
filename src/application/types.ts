/**
 * ActionIntent — unified write-path for all v0.2 domain operations.
 *
 * Agents and humans submit an ActionIntent; the Coordinator validates it,
 * generates one or more Events, advances aggregate state and updates read
 * models.  The intent itself is NOT a fact — only the produced Events are.
 */

export type ActionIntentType =
  // ─── Organization / Authority ───────────────────────────────────────────
  | "CreateOrganization"
  | "UpdateHandbook"
  | "AddMember"
  | "RemoveMember"
  | "AssignGuardian"
  | "GrantAuthority"
  | "RevokeAuthority"
  | "VetoProposal"
  | "EmergencyPause"
  | "EmergencyResume"
  | "RegisterAgentProfile"
  | "UpdateAgentProfile"
  | "UpsertMechanism"
  | "SeedKnowledgeEntry"
  // ─── Observation ────────────────────────────────────────────────────────
  | "CreateObservation"
  | "CreateObservationTask"
  | "RespondAssignmentOffer"
  | "SubmitObservationResult"
  // ─── Discussion ─────────────────────────────────────────────────────────
  | "StartDiscussion"
  | "AddComment"
  | "CloseDiscussionWithOutcome"
  | "CreateDiscussionRound"
  | "SubmitDiscussionContribution"
  // ─── Proposal / Voting ─────────────────────────────────────────────────
  | "SubmitProposal"
  | "CreateVotingRound"
  | "SubmitVote"
  // ─── Task / Artifact ────────────────────────────────────────────────────
  | "ClaimTask"
  | "SubmitTask"
  | "SubmitArtifact"
  | "AcceptArtifact"
  | "RejectArtifact"
  | "AcceptTask"
  | "RejectTask"
  // ─── Review ─────────────────────────────────────────────────────────────
  | "CreateReviewRound"
  | "SubmitReview"
  // ─── Reward / Settlement ────────────────────────────────────────────────
  | "CreateRewardIntent"
  | "ApproveRewardIntent"
  | "VetoReward"
  | "CreateSettlementBatch"
  | "ConfirmSettlementBatch"
  | "SubmitSettlement"
  // ─── Human / Request ────────────────────────────────────────────────────
  | "AnswerRequest";

export interface ActionIntent {
  type: ActionIntentType;
  /** The principal (agent or human) submitting the intent. */
  principalId: string;
  organizationId?: string;
  projectId?: string;
  /** Intent-specific parameters. */
  payload: Record<string, unknown>;
  /** Optional idempotency key supplied by the caller. */
  idempotencyKey?: string;
}

export interface ActionIntentResult {
  /** ID of the primary event produced. */
  eventId: string;
  /** Aggregate that was mutated. */
  aggregateRef: { kind: string; id: string };
  status: "accepted";
  /** All events produced (≥ 1). */
  events: unknown[];
}
