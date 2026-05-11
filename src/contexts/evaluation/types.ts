export type ReviewStatus = "pending" | "in-review" | "completed" | "cancelled";
export type ReviewOutcome = "accepted" | "rejected" | "needs-revision";

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
  createdAt: string;
  updatedAt: string;
}

export interface ReviewItem {
  reviewerId: string;
  outcome: ReviewOutcome;
  comment?: string;
  submittedAt: string;
}
