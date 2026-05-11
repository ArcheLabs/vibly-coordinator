/**
 * Organization Application Service — handles Organization-related
 * ActionIntents.
 *
 * Each handler:
 *  1. Validates the intent payload (via Zod).
 *  2. Loads current aggregate state from the repository.
 *  3. Calls domain logic (aggregate.apply / authority checks).
 *  4. Persists the new state.
 *  5. Creates and publishes a domain EventEnvelope.
 *  6. Returns ActionIntentResult.
 */

import { z } from "zod";
import { createEvent, makeId } from "@concord/foundation";
import type { ActionIntentDispatcher, DispatchContext } from "./actionIntentDispatcher.js";
import type { ActionIntent, ActionIntentResult } from "./types.js";
import { badRequest, conflict, notFound } from "../domain/errors.js";
import { OrganizationRepository } from "../contexts/organization/repository.js";
import { apply, type OrganizationEvent } from "../contexts/organization/aggregate.js";
import type { OrganizationHandbook, OrganizationMember, AuthorityAssignment } from "../contexts/organization/types.js";
import { isKnownAuthority } from "../contexts/authority/types.js";

// ─── Zod schemas ────────────────────────────────────────────────────────────

const createOrganizationSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const updateHandbookSchema = z.object({
  organizationId: z.string().min(1),
  handbook: z.object({
    mission: z.string().min(1),
    vision: z.string().optional(),
    values: z.array(z.string()).optional(),
    principles: z.array(z.string()).optional(),
    economicPolicy: z.record(z.unknown()).optional(),
    guardianPolicy: z.record(z.unknown()).optional(),
  }),
});

const addMemberSchema = z.object({
  organizationId: z.string().min(1),
  principalId: z.string().min(1),
  role: z.string().min(1),
});

const removeMemberSchema = z.object({
  organizationId: z.string().min(1),
  principalId: z.string().min(1),
});

const assignGuardianSchema = z.object({
  organizationId: z.string().min(1),
  principalId: z.string().min(1),
  authority: z.string().min(1),
});

const revokeAuthoritySchema = z.object({
  organizationId: z.string().min(1),
  principalId: z.string().min(1),
  authority: z.string().min(1),
});

const emergencyPauseSchema = z.object({
  organizationId: z.string().min(1),
  reason: z.string().optional(),
});

const emergencyResumeSchema = z.object({
  organizationId: z.string().min(1),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function parsePayload<T>(schema: z.ZodSchema<T>, intent: ActionIntent): T {
  const result = schema.safeParse(intent.payload);
  if (!result.success) {
    throw badRequest(`Invalid payload for ${intent.type}`, result.error.flatten());
  }
  return result.data;
}

function makeResult(event: ReturnType<typeof createEvent>, aggregateKind: string, aggregateId: string): ActionIntentResult {
  return {
    eventId: event.id,
    aggregateRef: { kind: aggregateKind, id: aggregateId },
    status: "accepted",
    events: [event],
  };
}

// ─── Handlers ───────────────────────────────────────────────────────────────

async function handleCreateOrganization(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const { name, description } = parsePayload(createOrganizationSchema, intent);
  const repo = new OrganizationRepository(ctx.store);

  const id = makeId("org");
  const now = new Date().toISOString();

  const domainEvent: OrganizationEvent = {
    type: "OrganizationCreated",
    payload: { id, name, description, createdBy: intent.principalId, createdAt: now },
  };

  const org = apply(undefined, domainEvent);
  await repo.save(org);
  await repo.saveOverview({
    id: org.id,
    name: org.name,
    description: org.description,
    status: org.status,
    memberCount: 0,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  });

  const env = createEvent({
    type: "OrganizationCreated",
    payload: domainEvent.payload,
    actorId: intent.principalId as never,
  });
  ctx.eventBus.publish(env);

  return makeResult(env, "Organization", id);
}

async function handleUpdateHandbook(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const { organizationId, handbook } = parsePayload(updateHandbookSchema, intent);
  const repo = new OrganizationRepository(ctx.store);
  const org = await repo.get(organizationId);
  if (!org) throw notFound("Organization", organizationId);

  const now = new Date().toISOString();
  const fullHandbook: OrganizationHandbook = { ...handbook, updatedAt: now, schemaVersion: "1" };

  const domainEvent: OrganizationEvent = {
    type: "HandbookUpdated",
    payload: { organizationId, handbook: fullHandbook, updatedAt: now },
  };
  const next = apply(org, domainEvent);
  await repo.save(next);
  await repo.saveOverview({ ...next, memberCount: next.members.length });

  const env = createEvent({ type: "HandbookUpdated", payload: domainEvent.payload, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "Organization", organizationId);
}

async function handleAddMember(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const { organizationId, principalId, role } = parsePayload(addMemberSchema, intent);
  const repo = new OrganizationRepository(ctx.store);
  const org = await repo.get(organizationId);
  if (!org) throw notFound("Organization", organizationId);

  const member: OrganizationMember = { principalId, role, joinedAt: new Date().toISOString() };
  const domainEvent: OrganizationEvent = { type: "MemberAdded", payload: { organizationId, member } };
  const next = apply(org, domainEvent);
  await repo.save(next);
  await repo.saveOverview({ ...next, memberCount: next.members.length });

  const env = createEvent({ type: "MemberAdded", payload: domainEvent.payload, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "Organization", organizationId);
}

async function handleRemoveMember(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const { organizationId, principalId } = parsePayload(removeMemberSchema, intent);
  const repo = new OrganizationRepository(ctx.store);
  const org = await repo.get(organizationId);
  if (!org) throw notFound("Organization", organizationId);

  const now = new Date().toISOString();
  const domainEvent: OrganizationEvent = { type: "MemberRemoved", payload: { organizationId, principalId, removedAt: now } };
  const next = apply(org, domainEvent);
  await repo.save(next);
  await repo.saveOverview({ ...next, memberCount: next.members.length });

  const env = createEvent({ type: "MemberRemoved", payload: domainEvent.payload, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "Organization", organizationId);
}

async function handleAssignGuardian(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const { organizationId, principalId, authority } = parsePayload(assignGuardianSchema, intent);
  if (!isKnownAuthority(authority)) {
    throw badRequest(`Unknown authority: ${authority}`);
  }
  const repo = new OrganizationRepository(ctx.store);
  const org = await repo.get(organizationId);
  if (!org) throw notFound("Organization", organizationId);

  const assignment: AuthorityAssignment = {
    principalId,
    authority,
    grantedAt: new Date().toISOString(),
    grantedBy: intent.principalId,
  };
  const domainEvent: OrganizationEvent = { type: "AuthorityGranted", payload: { organizationId, assignment } };
  const next = apply(org, domainEvent);
  await repo.save(next);

  const env = createEvent({ type: "AuthorityGranted", payload: domainEvent.payload, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "Organization", organizationId);
}

async function handleRevokeAuthority(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const { organizationId, principalId, authority } = parsePayload(revokeAuthoritySchema, intent);
  const repo = new OrganizationRepository(ctx.store);
  const org = await repo.get(organizationId);
  if (!org) throw notFound("Organization", organizationId);

  const now = new Date().toISOString();
  const domainEvent: OrganizationEvent = { type: "AuthorityRevoked", payload: { organizationId, principalId, authority, revokedAt: now } };
  const next = apply(org, domainEvent);
  await repo.save(next);

  const env = createEvent({ type: "AuthorityRevoked", payload: domainEvent.payload, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "Organization", organizationId);
}

async function handleEmergencyPause(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const { organizationId, reason } = parsePayload(emergencyPauseSchema, intent);
  const repo = new OrganizationRepository(ctx.store);
  const org = await repo.get(organizationId);
  if (!org) throw notFound("Organization", organizationId);
  if (org.status === "paused") throw conflict("Organization is already paused");

  const now = new Date().toISOString();
  const domainEvent: OrganizationEvent = { type: "OrganizationPaused", payload: { organizationId, pausedAt: now, reason } };
  const next = apply(org, domainEvent);
  await repo.save(next);
  await repo.saveOverview({ ...next, memberCount: next.members.length });

  const env = createEvent({ type: "OrganizationPaused", payload: domainEvent.payload, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "Organization", organizationId);
}

async function handleEmergencyResume(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const { organizationId } = parsePayload(emergencyResumeSchema, intent);
  const repo = new OrganizationRepository(ctx.store);
  const org = await repo.get(organizationId);
  if (!org) throw notFound("Organization", organizationId);
  if (org.status !== "paused") throw conflict("Organization is not paused");

  const now = new Date().toISOString();
  const domainEvent: OrganizationEvent = { type: "OrganizationResumed", payload: { organizationId, resumedAt: now } };
  const next = apply(org, domainEvent);
  await repo.save(next);
  await repo.saveOverview({ ...next, memberCount: next.members.length });

  const env = createEvent({ type: "OrganizationResumed", payload: domainEvent.payload, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "Organization", organizationId);
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerOrganizationHandlers(dispatcher: ActionIntentDispatcher): void {
  dispatcher
    .register("CreateOrganization", handleCreateOrganization)
    .register("UpdateHandbook", handleUpdateHandbook)
    .register("AddMember", handleAddMember)
    .register("RemoveMember", handleRemoveMember)
    .register("AssignGuardian", handleAssignGuardian)
    .register("GrantAuthority", handleAssignGuardian)
    .register("RevokeAuthority", handleRevokeAuthority)
    .register("EmergencyPause", handleEmergencyPause)
    .register("EmergencyResume", handleEmergencyResume);
}
