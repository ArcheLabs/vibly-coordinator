export type TaskStatus = "available" | "claimed" | "in-progress" | "submitted" | "accepted" | "rejected" | "cancelled";
export type SubmissionStatus = "pending-review" | "accepted" | "rejected";
export type TaskKind = "ordinary" | "observation";

export interface Task {
  id: string;
  projectId?: string;
  organizationId: string;
  proposalId?: string;
  title: string;
  description?: string;
  assigneeId?: string;
  status: TaskStatus;
  skillRequirements?: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  dueAt?: string;
  /** Distinguishes system-generated observation tasks from ordinary tasks. Defaults to "ordinary". */
  kind?: TaskKind;
  /** True when the task was created by the coordination scheduler, not by a user. */
  systemGenerated?: boolean;
  /** ID of the CoordinationRound this observation task belongs to. */
  roundId?: string;
  /** Hard deadline for submission (ISO timestamp). Applies to observation tasks. */
  deadlineAt?: string;
}

export interface TaskSubmission {
  id: string;
  taskId: string;
  submitterId: string;
  status: SubmissionStatus;
  summary: string;
  artifactIds?: string[];
  submittedAt: string;
  updatedAt: string;
}
