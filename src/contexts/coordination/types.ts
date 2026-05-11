/**
 * Coordination context — domain types.
 */

export type ObservationStatus = "pending" | "assigned" | "completed" | "cancelled";
export type DiscussionStatus = "open" | "closed";
export type ProposalStatus = "draft" | "under-review" | "accepted" | "rejected" | "vetoed";
export type VotingRoundStatus = "open" | "closed" | "cancelled";
export type AssignmentStatus = "offered" | "accepted" | "declined" | "timed-out";

export interface ObservationTask {
  id: string;
  organizationId: string;
  projectId?: string;
  title: string;
  description?: string;
  mechanismId?: string;
  deadline?: string;
  status: ObservationStatus;
  assigneeId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssignmentOffer {
  id: string;
  observationTaskId: string;
  assigneeId: string;
  status: AssignmentStatus;
  offeredAt: string;
  respondedAt?: string;
  expiresAt?: string;
}

export interface Observation {
  id: string;
  organizationId: string;
  projectId?: string;
  title: string;
  content: string;
  tags: string[];
  subjectRef?: { kind: string; id: string };
  observationTaskId?: string;
  submittedBy: string;
  status: "open" | "submitted" | "reviewed";
  createdAt: string;
  updatedAt: string;
}

export interface DiscussionComment {
  id: string;
  authorId: string;
  content: string;
  createdAt: string;
}

export interface DiscussionContribution {
  authorId: string;
  content: string;
  submittedAt: string;
}

export interface DiscussionRound {
  index: number;
  participantIds: string[];
  contributions: DiscussionContribution[];
  createdAt: string;
}

export interface DiscussionOutcome {
  outcome: "resolved" | "no-action" | "escalated" | "pending" | "knowledge-captured";
  summary?: string;
  nextActionRef?: { kind: string; id: string };
  closedAt: string;
  closedBy: string;
}

export interface DiscussionThread {
  id: string;
  organizationId: string;
  projectId?: string;
  title: string;
  targetRef?: { kind: string; id: string };
  status: DiscussionStatus;
  comments: DiscussionComment[];
  rounds: DiscussionRound[];
  outcome?: DiscussionOutcome;
  startedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Proposal {
  id: string;
  organizationId: string;
  projectId?: string;
  title: string;
  body: string;
  discussionRef?: { kind: string; id: string };
  suggestedTaskPlan: Record<string, unknown>[];
  status: ProposalStatus;
  votingRoundId?: string;
  submittedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Vote {
  voterId: string;
  stance: "approve" | "reject" | "abstain";
  reason?: string;
  submittedAt: string;
}

export interface VotingRound {
  id: string;
  proposalId: string;
  organizationId: string;
  mechanismId?: string;
  deadline?: string;
  votes: Vote[];
  result?: { outcome: "approved" | "rejected"; approveCount: number; rejectCount: number; abstainCount: number };
  status: VotingRoundStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
