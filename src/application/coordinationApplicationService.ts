/**
 * Coordination Application Service — handles Observation, Discussion,
 * Proposal, and VotingRound ActionIntents.
 */

import { z } from "zod";
import { createEvent, makeId } from "@concord/foundation";
import type { ActionIntentDispatcher, DispatchContext } from "./actionIntentDispatcher.js";
import type { ActionIntent, ActionIntentResult } from "./types.js";
import { badRequest, notFound } from "../domain/errors.js";
import { CoordinationRepository } from "../contexts/coordination/repository.js";
import { applyObservation, applyDiscussion, applyProposal, applyVotingRound } from "../contexts/coordination/aggregate.js";
import type { ObservationTask, Observation, DiscussionThread, Proposal, VotingRound } from "../contexts/coordination/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function parsePayload<T>(schema: z.ZodSchema<T>, intent: ActionIntent): T {
  const result = schema.safeParse(intent.payload);
  if (!result.success) throw badRequest(`Invalid payload for ${intent.type}`, result.error.flatten());
  return result.data;
}

function makeResult(event: ReturnType<typeof createEvent>, kind: string, id: string): ActionIntentResult {
  return { eventId: event.id, aggregateRef: { kind, id }, status: "accepted", events: [event] };
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const createObservationSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  subjectRef: z.object({ kind: z.string(), id: z.string() }).optional(),
});

const createObservationTaskSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  mechanismId: z.string().optional(),
  deadline: z.string().optional(),
});

const respondAssignmentOfferSchema = z.object({
  assignmentId: z.string().min(1),
  response: z.enum(["accept", "decline"]),
});

const submitObservationResultSchema = z.object({
  observationTaskId: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
});

const startDiscussionSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().optional(),
  title: z.string().min(1),
  targetRef: z.object({ kind: z.string(), id: z.string() }).optional(),
});

const addCommentSchema = z.object({
  discussionId: z.string().min(1),
  content: z.string().min(1),
});

const closeDiscussionWithOutcomeSchema = z.object({
  discussionId: z.string().min(1),
  outcome: z.enum(["resolved", "no-action", "escalated", "pending", "knowledge-captured"]),
  summary: z.string().optional(),
  nextActionRef: z.object({ kind: z.string(), id: z.string() }).optional(),
});

const createDiscussionRoundSchema = z.object({
  discussionId: z.string().min(1),
  participantIds: z.array(z.string()).optional(),
});

const submitDiscussionContributionSchema = z.object({
  discussionId: z.string().min(1),
  roundIndex: z.number().int().nonnegative(),
  content: z.string().min(1),
});

const submitProposalSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  discussionRef: z.object({ kind: z.string(), id: z.string() }).optional(),
  suggestedTaskPlan: z.array(z.record(z.unknown())).optional(),
});

const createVotingRoundSchema = z.object({
  proposalId: z.string().min(1),
  organizationId: z.string().min(1),
  mechanismId: z.string().optional(),
  deadline: z.string().optional(),
});

const submitVoteSchema = z.object({
  votingRoundId: z.string().min(1),
  stance: z.enum(["approve", "reject", "abstain"]),
  reason: z.string().optional(),
});

// ─── Handlers ───────────────────────────────────────────────────────────────

async function handleCreateObservation(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(createObservationSchema, intent);
  const repo = new CoordinationRepository(ctx.store);
  const id = makeId("obs");
  const now = new Date().toISOString();

  const observation: Observation = {
    id,
    organizationId: data.organizationId,
    projectId: data.projectId,
    title: data.title,
    content: data.content,
    tags: data.tags ?? [],
    subjectRef: data.subjectRef,
    submittedBy: intent.principalId,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
  await repo.saveObservation(observation);

  const env = createEvent({ type: "ObservationCreated", payload: { ...observation }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "Observation", id);
}

async function handleCreateObservationTask(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(createObservationTaskSchema, intent);
  const repo = new CoordinationRepository(ctx.store);
  const id = makeId("obstask");
  const now = new Date().toISOString();

  const task: ObservationTask = {
    id,
    organizationId: data.organizationId,
    projectId: data.projectId,
    title: data.title,
    description: data.description,
    mechanismId: data.mechanismId,
    deadline: data.deadline,
    status: "pending",
    assigneeId: undefined,
    createdBy: intent.principalId,
    createdAt: now,
    updatedAt: now,
  };
  await repo.saveObservationTask(task);

  const env = createEvent({ type: "ObservationTaskCreated", payload: { ...task }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "ObservationTask", id);
}

async function handleRespondAssignmentOffer(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(respondAssignmentOfferSchema, intent);
  const repo = new CoordinationRepository(ctx.store);
  const assignment = await repo.getAssignmentOffer(data.assignmentId);
  if (!assignment) throw notFound("AssignmentOffer", data.assignmentId);

  const now = new Date().toISOString();
  const updated = { ...assignment, status: data.response === "accept" ? "accepted" as const : "declined" as const, respondedAt: now };
  await repo.saveAssignmentOffer(updated);

  const eventType = data.response === "accept" ? "AssignmentAccepted" : "AssignmentDeclined";
  const env = createEvent({ type: eventType, payload: { assignmentId: data.assignmentId, principalId: intent.principalId, respondedAt: now }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "AssignmentOffer", data.assignmentId);
}

async function handleSubmitObservationResult(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(submitObservationResultSchema, intent);
  const repo = new CoordinationRepository(ctx.store);
  const task = await repo.getObservationTask(data.observationTaskId);
  if (!task) throw notFound("ObservationTask", data.observationTaskId);

  const obsId = makeId("obs");
  const now = new Date().toISOString();
  const observation: Observation = {
    id: obsId,
    organizationId: task.organizationId,
    projectId: task.projectId,
    title: `Result for ${task.title}`,
    content: data.content,
    tags: data.tags ?? [],
    submittedBy: intent.principalId,
    observationTaskId: data.observationTaskId,
    status: "submitted",
    createdAt: now,
    updatedAt: now,
  };
  await repo.saveObservation(observation);

  const updatedTask = { ...task, status: "completed" as const, updatedAt: now };
  await repo.saveObservationTask(updatedTask);

  const env = createEvent({ type: "ObservationSubmitted", payload: { observation, observationTaskId: data.observationTaskId }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "Observation", obsId);
}

async function handleStartDiscussion(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(startDiscussionSchema, intent);
  const repo = new CoordinationRepository(ctx.store);
  const id = makeId("disc");
  const now = new Date().toISOString();

  const discussion: DiscussionThread = {
    id,
    organizationId: data.organizationId,
    projectId: data.projectId,
    title: data.title,
    targetRef: data.targetRef,
    status: "open",
    comments: [],
    rounds: [],
    startedBy: intent.principalId,
    createdAt: now,
    updatedAt: now,
  };
  await repo.saveDiscussion(discussion);

  const env = createEvent({ type: "DiscussionStarted", payload: { ...discussion }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "DiscussionThread", id);
}

async function handleAddComment(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(addCommentSchema, intent);
  const repo = new CoordinationRepository(ctx.store);
  const discussion = await repo.getDiscussion(data.discussionId);
  if (!discussion) throw notFound("DiscussionThread", data.discussionId);

  const now = new Date().toISOString();
  const comment = { id: makeId("comment"), authorId: intent.principalId, content: data.content, createdAt: now };
  const updated = applyDiscussion(discussion, { type: "CommentAdded", payload: { discussionId: data.discussionId, comment } });
  await repo.saveDiscussion(updated);

  const env = createEvent({ type: "CommentAdded", payload: { discussionId: data.discussionId, comment }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "DiscussionThread", data.discussionId);
}

async function handleCloseDiscussionWithOutcome(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(closeDiscussionWithOutcomeSchema, intent);
  const repo = new CoordinationRepository(ctx.store);
  const discussion = await repo.getDiscussion(data.discussionId);
  if (!discussion) throw notFound("DiscussionThread", data.discussionId);

  const now = new Date().toISOString();
  const outcome = { outcome: data.outcome, summary: data.summary, nextActionRef: data.nextActionRef, closedAt: now, closedBy: intent.principalId };
  const updated = applyDiscussion(discussion, { type: "DiscussionOutcomeRecorded", payload: { discussionId: data.discussionId, outcome } });
  await repo.saveDiscussion(updated);

  const env = createEvent({ type: "DiscussionOutcomeRecorded", payload: { discussionId: data.discussionId, outcome }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "DiscussionThread", data.discussionId);
}

async function handleCreateDiscussionRound(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(createDiscussionRoundSchema, intent);
  const repo = new CoordinationRepository(ctx.store);
  const discussion = await repo.getDiscussion(data.discussionId);
  if (!discussion) throw notFound("DiscussionThread", data.discussionId);

  const now = new Date().toISOString();
  const round = { index: discussion.rounds.length, participantIds: data.participantIds ?? [], contributions: [], createdAt: now };
  const updated = applyDiscussion(discussion, { type: "DiscussionRoundCreated", payload: { discussionId: data.discussionId, round } });
  await repo.saveDiscussion(updated);

  const env = createEvent({ type: "DiscussionRoundCreated", payload: { discussionId: data.discussionId, round }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "DiscussionThread", data.discussionId);
}

async function handleSubmitDiscussionContribution(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(submitDiscussionContributionSchema, intent);
  const repo = new CoordinationRepository(ctx.store);
  const discussion = await repo.getDiscussion(data.discussionId);
  if (!discussion) throw notFound("DiscussionThread", data.discussionId);

  const now = new Date().toISOString();
  const contribution = { authorId: intent.principalId, content: data.content, submittedAt: now };
  const updated = applyDiscussion(discussion, { type: "DiscussionContributionSubmitted", payload: { discussionId: data.discussionId, roundIndex: data.roundIndex, contribution } });
  await repo.saveDiscussion(updated);

  const env = createEvent({ type: "DiscussionContributionSubmitted", payload: { discussionId: data.discussionId, roundIndex: data.roundIndex, contribution }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "DiscussionThread", data.discussionId);
}

async function handleSubmitProposal(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(submitProposalSchema, intent);
  const repo = new CoordinationRepository(ctx.store);
  const id = makeId("prop");
  const now = new Date().toISOString();

  const proposal: Proposal = {
    id,
    organizationId: data.organizationId,
    projectId: data.projectId,
    title: data.title,
    body: data.body,
    discussionRef: data.discussionRef,
    suggestedTaskPlan: data.suggestedTaskPlan ?? [],
    status: "draft",
    submittedBy: intent.principalId,
    createdAt: now,
    updatedAt: now,
  };
  await repo.saveProposal(proposal);

  const env = createEvent({ type: "ProposalSubmitted", payload: { ...proposal }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "Proposal", id);
}

async function handleCreateVotingRound(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(createVotingRoundSchema, intent);
  const repo = new CoordinationRepository(ctx.store);
  const proposal = await repo.getProposal(data.proposalId);
  if (!proposal) throw notFound("Proposal", data.proposalId);

  const id = makeId("vote");
  const now = new Date().toISOString();
  const votingRound: VotingRound = {
    id,
    proposalId: data.proposalId,
    organizationId: data.organizationId,
    mechanismId: data.mechanismId,
    deadline: data.deadline,
    votes: [],
    status: "open",
    createdBy: intent.principalId,
    createdAt: now,
    updatedAt: now,
  };
  await repo.saveVotingRound(votingRound);

  const updatedProposal = applyProposal(proposal, { type: "VotingRoundCreated", payload: { proposalId: data.proposalId, votingRoundId: id } });
  await repo.saveProposal(updatedProposal);

  const env = createEvent({ type: "VotingRoundCreated", payload: { ...votingRound }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "VotingRound", id);
}

async function handleSubmitVote(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(submitVoteSchema, intent);
  const repo = new CoordinationRepository(ctx.store);
  const votingRound = await repo.getVotingRound(data.votingRoundId);
  if (!votingRound) throw notFound("VotingRound", data.votingRoundId);

  const now = new Date().toISOString();
  const vote = { voterId: intent.principalId, stance: data.stance, reason: data.reason, submittedAt: now };
  const updated = applyVotingRound(votingRound, { type: "VoteSubmitted", payload: { votingRoundId: data.votingRoundId, vote } });
  await repo.saveVotingRound(updated);

  const env = createEvent({ type: "VoteSubmitted", payload: { votingRoundId: data.votingRoundId, vote }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "VotingRound", data.votingRoundId);
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerCoordinationHandlers(dispatcher: ActionIntentDispatcher): void {
  dispatcher
    .register("CreateObservation", handleCreateObservation)
    .register("CreateObservationTask", handleCreateObservationTask)
    .register("RespondAssignmentOffer", handleRespondAssignmentOffer)
    .register("SubmitObservationResult", handleSubmitObservationResult)
    .register("StartDiscussion", handleStartDiscussion)
    .register("AddComment", handleAddComment)
    .register("CloseDiscussionWithOutcome", handleCloseDiscussionWithOutcome)
    .register("CreateDiscussionRound", handleCreateDiscussionRound)
    .register("SubmitDiscussionContribution", handleSubmitDiscussionContribution)
    .register("SubmitProposal", handleSubmitProposal)
    .register("CreateVotingRound", handleCreateVotingRound)
    .register("SubmitVote", handleSubmitVote);
}
