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
import { IdentityRepository } from "../contexts/identity/repository.js";
import type { AgentProfile, Principal } from "../contexts/identity/types.js";
import { MechanismRepository } from "../contexts/mechanism/repository.js";
import type { CoordinationMechanism } from "../contexts/mechanism/types.js";
import { StakeRepository } from "../contexts/stake/repository.js";
import type { AgentStakeLedger } from "../contexts/stake/types.js";
import { CoordinationRepository } from "../contexts/coordination/repository.js";
import { ReviewRepository } from "../contexts/evaluation/repository.js";
import { WorkRepository } from "../contexts/work/repository.js";

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

const registerAgentProfileSchema = z.object({
  principalId: z.string().min(1),
  displayName: z.string().min(1),
  organizationIds: z.array(z.string().min(1)).min(1),
  capabilities: z.array(z.string().min(1)).default([]),
  reputationScore: z.number().optional(),
  stakeBalance: z.string().optional(),
  chainId: z.string().optional(),
  identityId: z.string().optional(),
  chainAgentId: z.string().optional(),
  dutyStatus: z.enum(["active", "paused"]).optional(),
  stakeStatus: z.enum(["active", "unbonding", "released", "missing", "stale"]).optional(),
});

const upsertAgentStakeLedgerSchema = z.object({
  chainId: z.string().min(1),
  identityId: z.string().min(1),
  chainAgentId: z.string().min(1),
  principalId: z.string().optional(),
  fundingAccount: z.string().optional(),
  activeAmount: z.string().default("0"),
  unbondingAmount: z.string().default("0"),
  status: z.enum(["active", "unbonding", "released", "missing", "stale"]),
  unlockAtBlock: z.string().optional(),
  releaseBlocked: z.boolean().default(false),
  releaseBlockReason: z.string().optional(),
  updatedAtBlock: z.string().optional(),
});

const agentDutySchema = z.object({
  principalId: z.string().min(1),
  reason: z.string().optional(),
});

const upsertMechanismSchema = z.object({
  id: z.string().min(1).optional(),
  organizationId: z.string().min(1),
  projectId: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  observerSelection: z.record(z.unknown()).optional(),
  participantSelection: z.record(z.unknown()).optional(),
  reviewerSelection: z.record(z.unknown()).optional(),
  voterSelection: z.record(z.unknown()).optional(),
  assignmentSelection: z.record(z.unknown()).optional(),
  timeout: z.record(z.unknown()).optional(),
  reward: z.record(z.unknown()).optional(),
  votingRule: z.string().optional(),
});

const seedKnowledgeEntrySchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  sourceRef: z.object({ type: z.string(), id: z.string() }).optional(),
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

async function handleRegisterAgentProfile(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(registerAgentProfileSchema, intent);
  const repo = new IdentityRepository(ctx.store);
  const now = new Date().toISOString();

  const existingPrincipal = await repo.getPrincipal(data.principalId);
  const principal: Principal = existingPrincipal ?? {
    id: data.principalId,
    kind: "agent",
    displayName: data.displayName,
    organizationIds: data.organizationIds,
    createdAt: now,
    updatedAt: now,
  };
  await repo.savePrincipal({
    ...principal,
    displayName: data.displayName,
    organizationIds: data.organizationIds,
    updatedAt: now,
  });

  const existingProfile = await repo.getAgentProfile(data.principalId);
  const profile: AgentProfile = {
    principalId: data.principalId,
    displayName: data.displayName,
    capabilities: data.capabilities ?? [],
    organizationIds: data.organizationIds,
    reputationScore: data.reputationScore,
    stakeBalance: data.stakeBalance,
    chainId: data.chainId,
    identityId: data.identityId,
    chainAgentId: data.chainAgentId,
    dutyStatus: data.dutyStatus ?? existingProfile?.dutyStatus ?? "active",
    stakeStatus: data.stakeStatus ?? existingProfile?.stakeStatus,
    createdAt: existingProfile?.createdAt ?? now,
    updatedAt: now,
  };
  await repo.saveAgentProfile(profile);

  const env = createEvent({ type: "AgentProfileRegistered", payload: { ...profile }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "AgentProfile", data.principalId);
}

async function handleUpsertAgentStakeLedger(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(upsertAgentStakeLedgerSchema, intent);
  const repo = new StakeRepository(ctx.store);
  const id = `${data.chainId}:${data.identityId}:${data.chainAgentId}`;
  const ledger: AgentStakeLedger = {
    id,
    chainId: data.chainId,
    identityId: data.identityId,
    chainAgentId: data.chainAgentId,
    principalId: data.principalId,
    fundingAccount: data.fundingAccount,
    activeAmount: data.activeAmount ?? "0",
    unbondingAmount: data.unbondingAmount ?? "0",
    status: data.status,
    unlockAtBlock: data.unlockAtBlock,
    releaseBlocked: data.releaseBlocked ?? false,
    releaseBlockReason: data.releaseBlockReason,
    updatedAtBlock: data.updatedAtBlock,
    indexedAt: new Date().toISOString(),
  };
  await repo.saveLedger(ledger);

  if (data.principalId) {
    const identity = new IdentityRepository(ctx.store);
    const profile = await identity.getAgentProfile(data.principalId);
    if (profile) {
      await identity.saveAgentProfile({ ...profile, stakeStatus: data.status, updatedAt: ledger.indexedAt });
    }
  }

  const events = [];
  const env = createEvent({ type: "AgentStakeLedgerSynced", payload: { ...ledger }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  events.push(env);

  if (data.principalId && data.status === "unbonding") {
    const blockers = await listBlockingObligations(ctx.store, data.principalId);
    if (blockers.length > 0 && !data.releaseBlocked) {
      const blockEvent = createEvent({
        type: "AgentStakeReleaseBlockRequested",
        payload: { ...ledger, blockers },
        actorId: intent.principalId as never,
      });
      ctx.eventBus.publish(blockEvent);
      events.push(blockEvent);
    } else if (blockers.length === 0 && data.releaseBlocked) {
      const clearEvent = createEvent({
        type: "AgentStakeReleaseClearRequested",
        payload: { ...ledger },
        actorId: intent.principalId as never,
      });
      ctx.eventBus.publish(clearEvent);
      events.push(clearEvent);
    }
  }

  return { eventId: env.id, aggregateRef: { kind: "AgentStakeLedger", id }, status: "accepted", events };
}

async function listBlockingObligations(store: DispatchContext["store"], principalId: string): Promise<Array<Record<string, unknown>>> {
  const coordination = new CoordinationRepository(store);
  const reviews = new ReviewRepository(store);
  const work = new WorkRepository(store);
  const blockers: Array<Record<string, unknown>> = [];

  for (const offer of await coordination.listAssignmentOffersForPrincipal(principalId)) {
    if (offer.status === "offered" || offer.status === "accepted") {
      blockers.push({ type: "assignmentOffer", id: offer.id, status: offer.status });
    }
  }
  for (const discussion of await coordination.listDiscussions()) {
    if (discussion.status !== "open") continue;
    for (const round of discussion.rounds) {
      if (round.participantIds.includes(principalId) && !round.contributions.some((c) => c.authorId === principalId)) {
        blockers.push({ type: "discussionRound", id: discussion.id, roundIndex: round.index });
      }
    }
  }
  for (const round of await reviews.list()) {
    if ((round.status === "pending" || round.status === "in-review") &&
      round.reviewerIds.includes(principalId) &&
      !round.reviews.some((review) => review.reviewerId === principalId)) {
      blockers.push({ type: "reviewRound", id: round.id });
    }
  }
  for (const task of await work.listTasks()) {
    if (task.assigneeId === principalId && ["claimed", "in-progress", "submitted"].includes(task.status)) {
      blockers.push({ type: "task", id: task.id, status: task.status });
    }
  }
  return blockers;
}

async function handleRequestAgentDutyPause(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(agentDutySchema, intent);
  const repo = new IdentityRepository(ctx.store);
  const profile = await repo.getAgentProfile(data.principalId);
  if (!profile) throw notFound("AgentProfile", data.principalId);
  const blockers = await listBlockingObligations(ctx.store, data.principalId);
  if (blockers.length > 0) throw conflict("Agent has unfinished public obligations", { blockers });

  const now = new Date().toISOString();
  const updated = { ...profile, dutyStatus: "paused" as const, updatedAt: now };
  await repo.saveAgentProfile(updated);
  const env = createEvent({
    type: "AgentDutyPaused",
    payload: { principalId: data.principalId, reason: data.reason, pausedAt: now },
    actorId: intent.principalId as never,
  });
  ctx.eventBus.publish(env);
  return makeResult(env, "AgentProfile", data.principalId);
}

async function handleResumeAgentDuty(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(agentDutySchema, intent);
  const repo = new IdentityRepository(ctx.store);
  const profile = await repo.getAgentProfile(data.principalId);
  if (!profile) throw notFound("AgentProfile", data.principalId);
  const now = new Date().toISOString();
  const updated = { ...profile, dutyStatus: "active" as const, updatedAt: now };
  await repo.saveAgentProfile(updated);
  const env = createEvent({
    type: "AgentDutyResumed",
    payload: { principalId: data.principalId, resumedAt: now },
    actorId: intent.principalId as never,
  });
  ctx.eventBus.publish(env);
  return makeResult(env, "AgentProfile", data.principalId);
}

async function handleUpsertMechanism(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(upsertMechanismSchema, intent);
  const repo = new MechanismRepository(ctx.store);
  const id = data.id ?? makeId("mech");
  const now = new Date().toISOString();
  const existing = await repo.get(id);

  const mechanism: CoordinationMechanism = {
    id,
    organizationId: data.organizationId,
    projectId: data.projectId,
    name: data.name,
    description: data.description,
    observerSelection: data.observerSelection as CoordinationMechanism["observerSelection"],
    participantSelection: data.participantSelection as CoordinationMechanism["participantSelection"],
    reviewerSelection: data.reviewerSelection as CoordinationMechanism["reviewerSelection"],
    voterSelection: data.voterSelection as CoordinationMechanism["voterSelection"],
    assignmentSelection: data.assignmentSelection as CoordinationMechanism["assignmentSelection"],
    timeout: data.timeout as CoordinationMechanism["timeout"],
    reward: data.reward as CoordinationMechanism["reward"],
    votingRule: data.votingRule as CoordinationMechanism["votingRule"],
    createdBy: existing?.createdBy ?? intent.principalId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await repo.save(mechanism);

  const env = createEvent({ type: "MechanismUpserted", payload: { ...mechanism }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "Mechanism", id);
}

async function handleSeedKnowledgeEntry(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const data = parsePayload(seedKnowledgeEntrySchema, intent);
  const id = makeId("kentry");
  const now = new Date().toISOString();
  const entry = {
    id,
    organizationId: data.organizationId,
    projectId: data.projectId,
    title: data.title,
    content: data.content,
    tags: data.tags ?? [],
    sourceRef: data.sourceRef,
    version: 1,
    createdBy: intent.principalId,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.store.saveProjection("knowledge_entry_v2", id, entry);

  const env = createEvent({ type: "KnowledgeEntryCreated", payload: { ...entry }, actorId: intent.principalId as never });
  ctx.eventBus.publish(env);
  return makeResult(env, "KnowledgeEntry", id);
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
    .register("EmergencyResume", handleEmergencyResume)
    .register("RegisterAgentProfile", handleRegisterAgentProfile)
    .register("UpdateAgentProfile", handleRegisterAgentProfile)
    .register("RequestAgentDutyPause", handleRequestAgentDutyPause)
    .register("ResumeAgentDuty", handleResumeAgentDuty)
    .register("UpsertMechanism", handleUpsertMechanism)
    .register("SeedKnowledgeEntry", handleSeedKnowledgeEntry)
    .register("UpsertAgentStakeLedger", handleUpsertAgentStakeLedger);
}
