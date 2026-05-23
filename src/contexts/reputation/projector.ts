/**
 * ReputationProjector — listens to domain events and records reputation
 * deltas for participating agents.
 *
 * Delta values are intentionally simple constants here.  A more
 * sophisticated policy (e.g., via @concord/reputation) can be wired in
 * by replacing the delta lookups below.
 */

import { makeId } from "@concord/foundation";
import type { EventBus, Unsubscribe } from "../../services/eventBus.js";
import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import { ReputationRepository } from "./repository.js";
import type { ReputationEvent, ReputationEventType } from "./types.js";

const DELTAS: Record<ReputationEventType, number> = {
  "assignment-completed": +5,
  "assignment-failed": -3,
  "assignment-timeout": -5,
  "review-completed": +3,
  "review-missed": -2,
  "observation-missed": -2,
  "vote-cast": +1,
  "proposal-accepted": +10,
  "task-accepted": +8,
  "task-rejected": -4,
  "discussion-contribution": +2,
};

async function record(
  repo: ReputationRepository,
  principalId: string,
  organizationId: string,
  eventType: ReputationEventType,
  reason: string,
  sourceEventId: string,
  sourceRef?: { type: string; id: string },
): Promise<void> {
  const delta = DELTAS[eventType] ?? 0;
  const now = new Date().toISOString();

  const repEvent: ReputationEvent = {
    id: makeId("rep"),
    principalId,
    organizationId,
    eventType,
    delta,
    reason,
    sourceEventId,
    sourceRef,
    recordedAt: now,
  };
  await repo.saveEvent(repEvent);

  // Update cumulative score
  const existing = await repo.getScore(organizationId, principalId);
  await repo.saveScore({
    principalId,
    organizationId,
    score: (existing?.score ?? 0) + delta,
    eventCount: (existing?.eventCount ?? 0) + 1,
    lastUpdatedAt: now,
  });
}

export function startReputationProjector(
  eventBus: EventBus,
  store: CoordinatorStorePort,
): Unsubscribe[] {
  const repo = new ReputationRepository(store);
  const subs: Unsubscribe[] = [];

  subs.push(eventBus.subscribe(async (env) => {
    const payload = env.payload as Record<string, unknown>;
    const observation = payload["observation"] as Record<string, unknown> | undefined;
    const assigneeId = (payload["assigneeId"] as string | undefined) ?? (observation?.["submittedBy"] as string | undefined);
    const orgId = (payload["organizationId"] as string | undefined) ?? (observation?.["organizationId"] as string | undefined);
    if (!assigneeId || !orgId) return;
    await record(repo, assigneeId, orgId, "assignment-completed", "Completed assignment offer", env.id, { type: "AssignmentOffer", id: (payload["id"] as string) ?? "" });
  }, (env) => env.type === "ObservationSubmitted"));

  subs.push(eventBus.subscribe(async (env) => {
    const payload = env.payload as Record<string, unknown>;
    const reviewerId = payload["reviewerId"] as string | undefined;
    const orgId = payload["organizationId"] as string | undefined;
    if (!reviewerId || !orgId) return;
    await record(repo, reviewerId, orgId, "review-completed", "Submitted review", env.id, { type: "ReviewRound", id: (payload["reviewRoundId"] as string) ?? "" });
  }, (env) => env.type === "ReviewSubmitted" || env.type === "ReviewRoundCompleted"));

  subs.push(eventBus.subscribe(async (env) => {
    const payload = env.payload as Record<string, unknown>;
    const voterId = payload["voterId"] as string | undefined;
    const orgId = payload["organizationId"] as string | undefined;
    if (!voterId || !orgId) return;
    await record(repo, voterId, orgId, "vote-cast", "Cast vote", env.id, { type: "VotingRound", id: (payload["votingRoundId"] as string) ?? "" });
  }, (env) => env.type === "VoteSubmitted"));

  subs.push(eventBus.subscribe(async (env) => {
    const payload = env.payload as Record<string, unknown>;
    const task = payload["task"] as Record<string, unknown> | undefined;
    const assigneeId = (task?.["assigneeId"] as string | undefined) ?? (payload["assigneeId"] as string | undefined);
    const orgId = (task?.["organizationId"] as string | undefined) ?? (payload["organizationId"] as string | undefined);
    if (!assigneeId || !orgId) return;
    await record(repo, assigneeId, orgId, "task-accepted", "Task accepted by reviewer", env.id, { type: "Task", id: (task?.["id"] as string) ?? "" });
  }, (env) => env.type === "TaskAccepted"));

  subs.push(eventBus.subscribe(async (env) => {
    const payload = env.payload as Record<string, unknown>;
    const task = payload["task"] as Record<string, unknown> | undefined;
    const assigneeId = (task?.["assigneeId"] as string | undefined) ?? (payload["assigneeId"] as string | undefined);
    const orgId = (task?.["organizationId"] as string | undefined) ?? (payload["organizationId"] as string | undefined);
    if (!assigneeId || !orgId) return;
    await record(repo, assigneeId, orgId, "task-rejected", "Task rejected by reviewer", env.id, { type: "Task", id: (task?.["id"] as string) ?? "" });
  }, (env) => env.type === "TaskRejected"));

  subs.push(eventBus.subscribe(async (env) => {
    const payload = env.payload as Record<string, unknown>;
    const assigneeId = payload["assigneeId"] as string | undefined;
    const orgId = payload["organizationId"] as string | undefined;
    if (!assigneeId || !orgId) return;
    await record(repo, assigneeId, orgId, "assignment-timeout", "Assignment offer timed out without response", env.id, { type: "AssignmentOffer", id: (payload["assignmentId"] as string) ?? "" });
  }, (env) => env.type === "AssignmentTimedOut"));

  return subs;
}
