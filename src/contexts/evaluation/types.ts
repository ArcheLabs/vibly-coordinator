export type ReviewStatus = "pending" | "in-review" | "completed" | "cancelled";
export type ReviewOutcome = "accepted" | "rejected" | "needs-revision";
export type ReviewCycleStatus = "active" | "passed" | "rejected" | "unresolved" | "expired";

export interface ReviewRound {
  id: string;
  taskId?: string;
  submissionId?: string;
  proposalId?: string;
  targetRef: { type: string; id: string };
  organizationId: string;
  mechanismId?: string;
  reviewerIds: string[];
  reviews: ReviewItem[];
  status: ReviewStatus;
  outcome?: ReviewOutcome;
  deadline?: string;
  /** Index of the currently active ReviewCycle (0-based). */
  currentCycleIndex?: number;
  /** Total number of cycles started so far. */
  totalCycles?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewItem {
  reviewerId: string;
  outcome: ReviewOutcome;
  /** Optional 0–100 score; older reviews without a score are treated as outcome-only. */
  score?: number;
  /** ID of the ReviewCycle this item belongs to. */
  reviewCycleId?: string;
  comment?: string;
  submittedAt: string;
}

export interface ReviewCycle {
  id: string;
  reviewRoundId: string;
  cycleIndex: number;
  taskId?: string;
  submissionId?: string;
  organizationId: string;
  reviewerIds: string[];
  reviews: ReviewItem[];
  status: ReviewCycleStatus;
  outcome?: ReviewOutcome;
  deadline: string;
  selectionAuditId?: string;
  createdAt: string;
  updatedAt: string;
}
