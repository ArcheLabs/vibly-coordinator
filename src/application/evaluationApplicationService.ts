/**
 * Evaluation Application Service — handles Review-related ActionIntents.
 * SubmitReview, AcceptReview, CreateReviewRound.
 */

import { z } from "zod";
import { createEvent, makeId } from "@concord/foundation";
import type { ActionIntentDispatcher, DispatchContext } from "./actionIntentDispatcher.js";
import type { ActionIntent, ActionIntentResult } from "./types.js";
import { badRequest, notFound } from "../domain/errors.js";
import { ReviewRepository } from "../contexts/evaluation/repository.js";
import type { ReviewRound, ReviewItem } from "../contexts/evaluation/types.js";

const createReviewRoundSchema = z.object({
  organizationId: z.string().min(1),
  targetRef: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  reviewerIds: z.array(z.string()).optional(),
  mechanismId: z.string().optional(),
  deadline: z.string().optional(),
  taskId: z.string().optional(),
  submissionId: z.string().optional(),
  proposalId: z.string().optional(),
});

const submitReviewSchema = z.object({
  reviewRoundId: z.string().min(1),
  outcome: z.enum(["accepted", "rejected", "needs-revision"]),
  comment: z.string().optional(),
});

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleCreateReviewRound(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = createReviewRoundSchema.parse(intent.payload);
  const reviewRepo = new ReviewRepository(ctx.store);

  const now = new Date().toISOString();
  const round: ReviewRound = {
    id: makeId("rev"),
    organizationId: payload.organizationId,
    targetRef: payload.targetRef,
    reviewerIds: payload.reviewerIds ?? [],
    reviews: [],
    status: "pending",
    mechanismId: payload.mechanismId,
    deadline: payload.deadline,
    taskId: payload.taskId,
    submissionId: payload.submissionId,
    proposalId: payload.proposalId,
    createdAt: now,
    updatedAt: now,
  };
  await reviewRepo.save(round);

  const event = createEvent({ type: "ReviewRoundCreated", payload: { ...round }, actorId: ctx.principalId });
  ctx.eventBus.publish(event);

  return { eventId: event.id, aggregateRef: { type: "ReviewRound", id: round.id }, status: "applied" };
}

async function handleSubmitReview(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = submitReviewSchema.parse(intent.payload);
  const reviewRepo = new ReviewRepository(ctx.store);

  const round = await reviewRepo.get(payload.reviewRoundId);
  if (!round) throw notFound("ReviewRound", payload.reviewRoundId);
  if (round.status === "completed" || round.status === "cancelled") {
    throw badRequest(`ReviewRound ${payload.reviewRoundId} is already ${round.status}`);
  }

  const now = new Date().toISOString();
  const existing = round.reviews.find((r) => r.reviewerId === ctx.principalId);
  if (existing) throw badRequest("You have already submitted a review for this round");

  const reviewItem: ReviewItem = {
    reviewerId: ctx.principalId,
    outcome: payload.outcome,
    comment: payload.comment,
    submittedAt: now,
  };
  const updatedReviews = [...round.reviews, reviewItem];

  // Check if all reviewers have submitted
  const allDone = round.reviewerIds.length > 0 && updatedReviews.length >= round.reviewerIds.length;
  const majorityCounts = updatedReviews.reduce(
    (acc, r) => { acc[r.outcome] = (acc[r.outcome] ?? 0) + 1; return acc; },
    {} as Record<string, number>,
  );
  const majorityOutcome = allDone
    ? (Object.entries(majorityCounts).sort((a, b) => b[1] - a[1])[0]?.[0] as ReviewRound["outcome"])
    : undefined;

  const updated: ReviewRound = {
    ...round,
    reviews: updatedReviews,
    status: allDone ? "completed" : "in-review",
    outcome: majorityOutcome,
    updatedAt: now,
  };
  await reviewRepo.save(updated);

  const eventType = allDone ? "ReviewRoundCompleted" : "ReviewSubmitted";
  const event = createEvent({ type: eventType, payload: { ...updated, newReview: reviewItem }, actorId: ctx.principalId });
  ctx.eventBus.publish(event);

  return { eventId: event.id, aggregateRef: { type: "ReviewRound", id: round.id }, status: "applied" };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerEvaluationHandlers(dispatcher: ActionIntentDispatcher): void {
  dispatcher.register("CreateReviewRound", handleCreateReviewRound);
  dispatcher.register("SubmitReview", handleSubmitReview);
}
