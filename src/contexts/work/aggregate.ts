import type { Task, TaskSubmission } from "./types.js";

type TaskEvent =
  | { type: "TaskCreated"; payload: Partial<Task> }
  | { type: "TaskClaimed"; payload: { taskId: string; assigneeId: string; claimedAt: string } }
  | { type: "TaskSubmitted"; payload: { taskId: string; submittedAt: string } }
  | { type: "TaskAccepted"; payload: { taskId: string; acceptedAt: string } }
  | { type: "TaskRejected"; payload: { taskId: string; rejectedAt: string } }
  | { type: "TaskCancelled"; payload: { taskId: string; cancelledAt: string } };

export function applyTask(state: Task, event: TaskEvent): Task {
  const now = new Date().toISOString();
  switch (event.type) {
    case "TaskCreated":
      return { ...state, ...event.payload, updatedAt: now };
    case "TaskClaimed":
      return { ...state, assigneeId: event.payload.assigneeId, status: "claimed", updatedAt: event.payload.claimedAt };
    case "TaskSubmitted":
      return { ...state, status: "submitted", updatedAt: event.payload.submittedAt };
    case "TaskAccepted":
      return { ...state, status: "accepted", updatedAt: event.payload.acceptedAt };
    case "TaskRejected":
      return { ...state, status: "rejected", updatedAt: event.payload.rejectedAt };
    case "TaskCancelled":
      return { ...state, status: "cancelled", updatedAt: event.payload.cancelledAt };
    default:
      return state;
  }
}
