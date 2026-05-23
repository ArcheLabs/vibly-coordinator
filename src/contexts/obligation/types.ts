export type ObligationKind = "review" | "observation";

export type ObligationStatus =
  | "pending_notification"
  | "notified"
  | "acknowledged"
  | "submitted"
  | "missed"
  | "excused";

export interface AgentObligation {
  id: string;
  kind: ObligationKind;
  agentId: string;
  organizationId: string;
  projectId?: string;
  taskId?: string;
  reviewRoundId?: string;
  reviewCycleId?: string;
  assignmentOfferId?: string;
  notificationId?: string;
  status: ObligationStatus;
  notifiedAt?: string;
  acknowledgedAt?: string;
  submittedAt?: string;
  missedAt?: string;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
}
