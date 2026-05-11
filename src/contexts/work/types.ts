export type TaskStatus = "available" | "claimed" | "in-progress" | "submitted" | "accepted" | "rejected" | "cancelled";
export type SubmissionStatus = "pending-review" | "accepted" | "rejected";

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
