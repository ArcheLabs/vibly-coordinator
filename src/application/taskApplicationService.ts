/**
 * Task Application Service — handles Work-related ActionIntents.
 * ClaimTask, SubmitTask, SubmitArtifact, AcceptTask, RejectTask.
 */

import { z } from "zod";
import { createEvent, makeId } from "@concord/foundation";
import type { ActionIntentDispatcher, DispatchContext } from "./actionIntentDispatcher.js";
import type { ActionIntent, ActionIntentResult } from "./types.js";
import { badRequest, notFound } from "../domain/errors.js";
import { WorkRepository } from "../contexts/work/repository.js";
import { ArtifactRepository } from "../contexts/artifact/repository.js";
import { applyTask } from "../contexts/work/aggregate.js";
import type { Task, TaskSubmission } from "../contexts/work/types.js";
import type { Artifact } from "../contexts/artifact/types.js";

const claimTaskSchema = z.object({
  taskId: z.string().min(1),
  organizationId: z.string().min(1),
});

const submitTaskSchema = z.object({
  taskId: z.string().min(1),
  organizationId: z.string().min(1),
  summary: z.string().min(1),
  artifactIds: z.array(z.string()).optional(),
});

const submitArtifactSchema = z.object({
  organizationId: z.string().min(1),
  taskId: z.string().optional(),
  title: z.string().min(1),
  mimeType: z.string().min(1),
  contentRef: z.string().min(1),
  contentHash: z.string().optional(),
  sizeBytes: z.number().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const acceptRejectTaskSchema = z.object({
  taskId: z.string().min(1),
  organizationId: z.string().min(1),
  submissionId: z.string().optional(),
});

const acceptRejectArtifactSchema = z.object({
  artifactId: z.string().min(1),
  organizationId: z.string().min(1),
  reason: z.string().optional(),
});

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleClaimTask(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = claimTaskSchema.parse(intent.payload);
  const workRepo = new WorkRepository(ctx.store);

  const task = await workRepo.getTask(payload.taskId);
  if (!task) throw notFound("Task", payload.taskId);
  if (task.status !== "available") throw badRequest(`Task ${payload.taskId} is not available (status: ${task.status})`);

  const now = new Date().toISOString();
  const next = applyTask(task, {
    type: "TaskClaimed",
    payload: { taskId: task.id, assigneeId: ctx.principalId, claimedAt: now },
  });
  await workRepo.saveTask(next);

  const event = createEvent({ type: "TaskClaimed", payload: { ...next }, actorId: ctx.principalId as never });
  ctx.eventBus.publish(event);

  return { eventId: event.id, aggregateRef: { kind: "Task", id: task.id }, status: "accepted", events: [event] };
}

async function handleSubmitTask(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = submitTaskSchema.parse(intent.payload);
  const workRepo = new WorkRepository(ctx.store);

  const task = await workRepo.getTask(payload.taskId);
  if (!task) throw notFound("Task", payload.taskId);
  if (task.assigneeId !== ctx.principalId) throw badRequest("Only the assignee can submit the task");

  const now = new Date().toISOString();
  const submission: TaskSubmission = {
    id: makeId("sub"),
    taskId: task.id,
    submitterId: ctx.principalId,
    status: "pending-review",
    summary: payload.summary,
    artifactIds: payload.artifactIds,
    submittedAt: now,
    updatedAt: now,
  };
  await workRepo.saveSubmission(submission);

  const next = applyTask(task, { type: "TaskSubmitted", payload: { taskId: task.id, submittedAt: now } });
  await workRepo.saveTask(next);

  const event = createEvent({
    type: "TaskSubmitted",
    payload: { task: next, submission },
    actorId: ctx.principalId as never,
  });
  ctx.eventBus.publish(event);

  return { eventId: event.id, aggregateRef: { kind: "Task", id: task.id }, status: "accepted", events: [event] };
}

async function handleSubmitArtifact(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = submitArtifactSchema.parse(intent.payload);
  const artifactRepo = new ArtifactRepository(ctx.store);

  const now = new Date().toISOString();
  const artifact: Artifact = {
    id: makeId("art"),
    organizationId: payload.organizationId,
    taskId: payload.taskId,
    createdBy: ctx.principalId,
    status: "submitted",
    mimeType: payload.mimeType,
    title: payload.title,
    description: payload.description,
    contentRef: payload.contentRef,
    contentHash: payload.contentHash,
    sizeBytes: payload.sizeBytes,
    tags: payload.tags,
    createdAt: now,
    updatedAt: now,
  };
  await artifactRepo.save(artifact);

  const event = createEvent({ type: "ArtifactSubmitted", payload: { artifact }, actorId: ctx.principalId as never });
  ctx.eventBus.publish(event);

  return { eventId: event.id, aggregateRef: { kind: "Artifact", id: artifact.id }, status: "accepted", events: [event] };
}

async function handleAcceptTask(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = acceptRejectTaskSchema.parse(intent.payload);
  const workRepo = new WorkRepository(ctx.store);

  const task = await workRepo.getTask(payload.taskId);
  if (!task) throw notFound("Task", payload.taskId);

  const now = new Date().toISOString();
  const next = applyTask(task, { type: "TaskAccepted", payload: { taskId: task.id, acceptedAt: now } });
  await workRepo.saveTask(next);

  const event = createEvent({ type: "TaskAccepted", payload: { ...next }, actorId: ctx.principalId as never });
  ctx.eventBus.publish(event);

  return { eventId: event.id, aggregateRef: { kind: "Task", id: task.id }, status: "accepted", events: [event] };
}

async function handleRejectTask(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = acceptRejectTaskSchema.parse(intent.payload);
  const workRepo = new WorkRepository(ctx.store);

  const task = await workRepo.getTask(payload.taskId);
  if (!task) throw notFound("Task", payload.taskId);

  const now = new Date().toISOString();
  const next = applyTask(task, { type: "TaskRejected", payload: { taskId: task.id, rejectedAt: now } });
  await workRepo.saveTask(next);

  const event = createEvent({ type: "TaskRejected", payload: { ...next }, actorId: ctx.principalId as never });
  ctx.eventBus.publish(event);

  return { eventId: event.id, aggregateRef: { kind: "Task", id: task.id }, status: "accepted", events: [event] };
}

async function handleAcceptArtifact(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = acceptRejectArtifactSchema.parse(intent.payload);
  const artifactRepo = new ArtifactRepository(ctx.store);
  const artifact = await artifactRepo.get(payload.artifactId);
  if (!artifact) throw notFound("Artifact", payload.artifactId);

  const now = new Date().toISOString();
  const next: Artifact = { ...artifact, status: "accepted", updatedAt: now };
  await artifactRepo.save(next);

  const event = createEvent({
    type: "ArtifactAccepted",
    payload: { artifact: next, organizationId: payload.organizationId, reason: payload.reason },
    actorId: ctx.principalId as never,
  });
  ctx.eventBus.publish(event);
  return { eventId: event.id, aggregateRef: { kind: "Artifact", id: artifact.id }, status: "accepted", events: [event] };
}

async function handleRejectArtifact(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = acceptRejectArtifactSchema.parse(intent.payload);
  const artifactRepo = new ArtifactRepository(ctx.store);
  const artifact = await artifactRepo.get(payload.artifactId);
  if (!artifact) throw notFound("Artifact", payload.artifactId);

  const now = new Date().toISOString();
  const next: Artifact = { ...artifact, status: "rejected", updatedAt: now };
  await artifactRepo.save(next);

  const event = createEvent({
    type: "ArtifactRejected",
    payload: { artifact: next, organizationId: payload.organizationId, reason: payload.reason },
    actorId: ctx.principalId as never,
  });
  ctx.eventBus.publish(event);
  return { eventId: event.id, aggregateRef: { kind: "Artifact", id: artifact.id }, status: "accepted", events: [event] };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerWorkHandlers(dispatcher: ActionIntentDispatcher): void {
  dispatcher.register("ClaimTask", handleClaimTask);
  dispatcher.register("SubmitTask", handleSubmitTask);
  dispatcher.register("SubmitArtifact", handleSubmitArtifact);
  dispatcher.register("AcceptTask", handleAcceptTask);
  dispatcher.register("RejectTask", handleRejectTask);
  dispatcher.register("AcceptArtifact", handleAcceptArtifact);
  dispatcher.register("RejectArtifact", handleRejectArtifact);
}
