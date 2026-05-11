/**
 * Coordination aggregate — pure `apply` functions for each object type.
 */

import type { DiscussionThread, Proposal, VotingRound } from "./types.js";

// ─── Observation (simple mutations via repository; no complex state machine) ─

// ─── Discussion ────────────────────────────────────────────────────────────

export type DiscussionEvent =
  | { type: "CommentAdded"; payload: { discussionId: string; comment: import("./types.js").DiscussionComment } }
  | { type: "DiscussionRoundCreated"; payload: { discussionId: string; round: import("./types.js").DiscussionRound } }
  | { type: "DiscussionContributionSubmitted"; payload: { discussionId: string; roundIndex: number; contribution: import("./types.js").DiscussionContribution } }
  | { type: "DiscussionOutcomeRecorded"; payload: { discussionId: string; outcome: import("./types.js").DiscussionOutcome } };

export function applyDiscussion(state: DiscussionThread, event: DiscussionEvent): DiscussionThread {
  const now = new Date().toISOString();
  switch (event.type) {
    case "CommentAdded":
      return { ...state, comments: [...state.comments, event.payload.comment], updatedAt: now };
    case "DiscussionRoundCreated":
      return { ...state, rounds: [...state.rounds, event.payload.round], updatedAt: now };
    case "DiscussionContributionSubmitted": {
      const rounds = state.rounds.map((r) =>
        r.index === event.payload.roundIndex
          ? { ...r, contributions: [...r.contributions, event.payload.contribution] }
          : r,
      );
      return { ...state, rounds, updatedAt: now };
    }
    case "DiscussionOutcomeRecorded":
      return { ...state, outcome: event.payload.outcome, status: "closed", updatedAt: now };
  }
}

// ─── Proposal ─────────────────────────────────────────────────────────────

export type ProposalEvent =
  | { type: "VotingRoundCreated"; payload: { proposalId: string; votingRoundId: string } }
  | { type: "ProposalAccepted"; payload: { proposalId: string; acceptedAt: string } }
  | { type: "ProposalRejected"; payload: { proposalId: string; rejectedAt: string } }
  | { type: "ProposalVetoed"; payload: { proposalId: string; vetoedBy: string; reason?: string; vetoedAt: string } };

export function applyProposal(state: Proposal, event: ProposalEvent): Proposal {
  const now = new Date().toISOString();
  switch (event.type) {
    case "VotingRoundCreated":
      return { ...state, votingRoundId: event.payload.votingRoundId, status: "under-review", updatedAt: now };
    case "ProposalAccepted":
      return { ...state, status: "accepted", updatedAt: event.payload.acceptedAt };
    case "ProposalRejected":
      return { ...state, status: "rejected", updatedAt: event.payload.rejectedAt };
    case "ProposalVetoed":
      return { ...state, status: "vetoed", updatedAt: event.payload.vetoedAt };
  }
}

// ─── VotingRound ──────────────────────────────────────────────────────────

export type VotingRoundEvent =
  | { type: "VoteSubmitted"; payload: { votingRoundId: string; vote: import("./types.js").Vote } }
  | { type: "VotingRoundClosed"; payload: { votingRoundId: string; result: VotingRound["result"]; closedAt: string } };

export function applyVotingRound(state: VotingRound, event: VotingRoundEvent): VotingRound {
  const now = new Date().toISOString();
  switch (event.type) {
    case "VoteSubmitted":
      return {
        ...state,
        votes: [
          ...state.votes.filter((v) => v.voterId !== event.payload.vote.voterId),
          event.payload.vote,
        ],
        updatedAt: now,
      };
    case "VotingRoundClosed":
      return { ...state, result: event.payload.result, status: "closed", updatedAt: event.payload.closedAt };
  }
}

// ─── Observation Aggregate ────────────────────────────────────────────────

export function applyObservation(
  _state: import("./types.js").Observation | undefined,
  _event: { type: string; payload: unknown },
): import("./types.js").Observation {
  // Observations are created directly via repository; no state-machine needed yet.
  throw new Error("Use repository directly for Observation mutations");
}
