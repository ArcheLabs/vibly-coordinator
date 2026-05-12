/**
 * Reputation context types.
 *
 * Reputation is computed from domain events (assignment completions, reviews,
 * voting participation, etc.) by the reputation projector.
 */

export type ReputationEventType =
  | "assignment-completed"
  | "assignment-failed"
  | "assignment-timeout"
  | "review-completed"
  | "vote-cast"
  | "proposal-accepted"
  | "task-accepted"
  | "task-rejected"
  | "discussion-contribution";

export interface ReputationEvent {
  id: string;
  principalId: string;
  organizationId: string;
  eventType: ReputationEventType;
  delta: number;
  reason: string;
  sourceEventId?: string;
  sourceRef?: { type: string; id: string };
  recordedAt: string;
}

export interface AgentReputation {
  principalId: string;
  organizationId: string;
  score: number;
  eventCount: number;
  lastUpdatedAt: string;
}
