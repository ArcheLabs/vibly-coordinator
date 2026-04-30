import type { FastifyPluginAsync } from "fastify";
import { createEvent, makeId } from "@concord/foundation";
import { ok, okList } from "../../domain/apiTypes.js";

const PHASE_F_RUN_KIND = "phase_f_run";
const PHASE_H_RUN_KIND = "phase_h_run";
const REWARD_INTENT_KIND = "reward_intent";
const REPUTATION_EVIDENCE_KIND = "reputation_evidence";
const SLASH_REQUEST_KIND = "slash_request";
const GUARDIAN_REQUEST_KIND = "guardian_request";

type RewardStatus = "draft" | "reserved" | "claimable" | "approved" | "claimed" | "cancelled";

interface RewardIntent {
  id: string;
  projectId?: string;
  workOrderId?: string;
  amount: string;
  currency: string;
  recipient: string;
  status: RewardStatus;
  fundingReceipt?: unknown;
  settlementReceipt?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface ReputationEvidence {
  id: string;
  projectId: string;
  actorId: string;
  kind: "positive" | "negative" | "slash";
  scoreDelta: number;
  reason: string;
  source: Record<string, string | undefined>;
  createdAt: string;
}

interface SlashRequest {
  id: string;
  projectId: string;
  actorId: string;
  reason: string;
  severity: "low" | "medium" | "high";
  status: "pending" | "approved" | "rejected";
  guardianRequestId: string;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface PhaseHTimelineEntry {
  id: string;
  projectId: string;
  phase: string;
  title: string;
  status: string;
  actorId?: string;
  reason?: string;
  eventType: string;
  entityIds?: Record<string, string | undefined>;
  timestamp: string;
}

interface PhaseHRun {
  id: string;
  projectId: string;
  phaseFRunId: string;
  rewardIntent: RewardIntent;
  positiveEvidence: ReputationEvidence;
  negativeEvidence: ReputationEvidence;
  slashRequest: SlashRequest;
  guardianRequest: Record<string, unknown>;
  ledger: unknown;
  timeline: PhaseHTimelineEntry[];
  createdAt: string;
}

const phaseHRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/phase-h/smoke", async (_request, reply) => {
    if (!fastify.config.enableDevRoutes) {
      return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: "Dev routes disabled" }, meta: { requestId: "req_" + Date.now() } });
    }

    const phaseFRun = await ensurePhaseFRun(fastify);
    const run = await createPhaseHRun(fastify, phaseFRun);
    return ok({ run });
  });

  fastify.get<{ Querystring: { projectId?: string; limit?: string; cursor?: string } }>("/phase-h/runs", async (request) => {
    const { projectId, limit: limitStr, cursor } = request.query;
    const limit = Math.min(Number(limitStr) || 50, 200);
    let runs = fastify.coordinatorStore.listProjections<PhaseHRun>(PHASE_H_RUN_KIND);
    if (projectId) runs = runs.filter((run) => run.projectId === projectId);
    let startIdx = 0;
    if (cursor) {
      const idx = runs.findIndex((run) => run.id === cursor);
      if (idx !== -1) startIdx = idx + 1;
    }
    const page = runs.slice(startIdx, startIdx + limit);
    const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
    return okList(page, { limit, nextCursor });
  });

  fastify.get<{ Params: { projectId: string } }>("/projects/:projectId/phase-h/overview", async (request) => {
    const { projectId } = request.params;
    const rewards = rewardsForProject(fastify, projectId);
    const reputationEvidence = reputationForProject(fastify, projectId);
    const slashRequests = slashForProject(fastify, projectId);
    const runs = fastify.coordinatorStore.listProjections<PhaseHRun>(PHASE_H_RUN_KIND).filter((run) => run.projectId === projectId);
    const guardianRequests = fastify.coordinatorStore.listProjections<{ projectId?: string }>(GUARDIAN_REQUEST_KIND).filter((item) => item.projectId === projectId);
    return ok({
      overview: {
        projectId,
        counts: {
          phaseHRuns: runs.length,
          rewardIntents: rewards.length,
          claimableRewards: rewards.filter((reward) => reward.status === "claimable" || reward.status === "approved").length,
          claimedRewards: rewards.filter((reward) => reward.status === "claimed").length,
          reputationEvidence: reputationEvidence.length,
          slashRequests: slashRequests.length,
          guardianRequests: guardianRequests.length,
        },
        latestRun: runs.at(-1) ?? null,
        ledger: ledgerSummary(rewards),
        live: { streamPath: `/projects/${projectId}/stream`, source: "coordinator_event_bus" },
      },
    });
  });

  fastify.get<{ Querystring: { projectId?: string; actorId?: string; kind?: string; limit?: string; cursor?: string } }>("/reputation/evidence", async (request) => {
    const { projectId, actorId, kind, limit: limitStr, cursor } = request.query;
    const limit = Math.min(Number(limitStr) || 50, 200);
    let items = fastify.coordinatorStore.listProjections<ReputationEvidence>(REPUTATION_EVIDENCE_KIND);
    if (projectId) items = items.filter((item) => item.projectId === projectId);
    if (actorId) items = items.filter((item) => item.actorId === actorId);
    if (kind) items = items.filter((item) => item.kind === kind);
    let startIdx = 0;
    if (cursor) {
      const idx = items.findIndex((item) => item.id === cursor);
      if (idx !== -1) startIdx = idx + 1;
    }
    const page = items.slice(startIdx, startIdx + limit);
    const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
    return okList(page, { limit, nextCursor });
  });

  fastify.get<{ Querystring: { projectId?: string; actorId?: string; status?: string; limit?: string; cursor?: string } }>("/slash-requests", async (request) => {
    const { projectId, actorId, status, limit: limitStr, cursor } = request.query;
    const limit = Math.min(Number(limitStr) || 50, 200);
    let items = fastify.coordinatorStore.listProjections<SlashRequest>(SLASH_REQUEST_KIND);
    if (projectId) items = items.filter((item) => item.projectId === projectId);
    if (actorId) items = items.filter((item) => item.actorId === actorId);
    if (status) items = items.filter((item) => item.status === status);
    let startIdx = 0;
    if (cursor) {
      const idx = items.findIndex((item) => item.id === cursor);
      if (idx !== -1) startIdx = idx + 1;
    }
    const page = items.slice(startIdx, startIdx + limit);
    const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
    return okList(page, { limit, nextCursor });
  });
};

async function ensurePhaseFRun(fastify: Parameters<FastifyPluginAsync>[0]): Promise<Record<string, unknown>> {
  const existing = fastify.coordinatorStore.listProjections<Record<string, unknown>>(PHASE_F_RUN_KIND).at(-1);
  if (existing) return existing;
  const response = await fastify.inject({ method: "POST", url: "/phase-f/smoke" });
  if (response.statusCode >= 400) throw new Error(`Phase F prerequisite smoke failed: ${response.body}`);
  const payload = response.json<{ data: { run: Record<string, unknown> } }>();
  return payload.data.run;
}

async function createPhaseHRun(fastify: Parameters<FastifyPluginAsync>[0], phaseFRun: Record<string, unknown>): Promise<PhaseHRun> {
  const projectId = String(phaseFRun.projectId);
  const workOrder = asRecord(phaseFRun.workOrder);
  const review = asRecord(phaseFRun.review);
  const roles = asRecord(phaseFRun.roles);
  const workerId = String(roles.worker ?? asRecord(phaseFRun.submission).submittedBy ?? "worker");
  const reviewerId = String(roles.reviewer ?? review.reviewerId ?? "reviewer");
  const guardianId = String(roles.guardian ?? "guardian");
  const now = new Date().toISOString();
  const timeline: PhaseHTimelineEntry[] = [];

  const rewardIntent: RewardIntent = {
    id: makeId("RewardIntentId", `phase-h-reward-${workOrder.id ?? phaseFRun.id}`),
    projectId,
    workOrderId: String(workOrder.id ?? ""),
    amount: "100",
    currency: "VIBLY_MOCK",
    recipient: workerId,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  fastify.coordinatorStore.saveProjection(REWARD_INTENT_KIND, rewardIntent.id, rewardIntent);
  await appendAndPublish(fastify, "RewardIntentCreated", rewardIntent, workerId, projectId, timeline, "reward", "Reward intent created for accepted work", "draft");

  const fundingReceipt = await fastify.concord.fundingGateway.reserve({
    amount: rewardIntent.amount,
    currency: rewardIntent.currency,
    recipient: rewardIntent.recipient,
    referenceId: rewardIntent.id,
  });
  const claimableReward: RewardIntent = { ...rewardIntent, status: "claimable", fundingReceipt, updatedAt: new Date().toISOString() };
  fastify.coordinatorStore.saveProjection(REWARD_INTENT_KIND, claimableReward.id, claimableReward);
  await appendAndPublish(fastify, "FundingReserved", { projectId, rewardIntentId: claimableReward.id, fundingReceipt }, workerId, projectId, timeline, "ledger", "Mock funding reserved", "reserved");
  await appendAndPublish(fastify, "RewardClaimable", claimableReward, reviewerId, projectId, timeline, "reward", "Accepted review made the reward claimable", "claimable");

  const positiveEvidence = makeReputationEvidence(projectId, workerId, "positive", 0.2, "Accepted Phase F work produced auditable evidence.", { workOrderId: String(workOrder.id ?? ""), rewardIntentId: claimableReward.id });
  const negativeEvidence = makeReputationEvidence(projectId, workerId, "slash", -0.3, "Injected Phase H risk sample: missing follow-up artifact would justify slash review.", { workOrderId: String(workOrder.id ?? ""), rewardIntentId: claimableReward.id });
  for (const evidence of [positiveEvidence, negativeEvidence]) {
    fastify.coordinatorStore.saveProjection(REPUTATION_EVIDENCE_KIND, evidence.id, evidence);
    await appendAndPublish(fastify, "ReputationEvidenceCreated", evidence, evidence.actorId, projectId, timeline, "reputation", evidence.reason, evidence.kind);
  }

  const guardianRequest = {
    id: makeId("DecisionRecordId", `phase-h-guardian-${negativeEvidence.id}`),
    projectId,
    actionId: String(asRecord(phaseFRun.action).id ?? ""),
    requestedBy: reviewerId,
    guardianId,
    status: "approved",
    riskLevel: "high",
    reason: "Slash request requires Guardian visibility before it affects reputation.",
    evidenceIds: [negativeEvidence.id],
  };
  fastify.coordinatorStore.saveProjection(GUARDIAN_REQUEST_KIND, String(guardianRequest.id), guardianRequest);
  await appendAndPublish(fastify, "GuardianReviewRequested", { ...guardianRequest, status: "pending" }, reviewerId, projectId, timeline, "guardian", guardianRequest.reason, "pending");
  await appendAndPublish(fastify, "GuardianReviewCompleted", guardianRequest, guardianId, projectId, timeline, "guardian", "Guardian approved the minimal slash evidence path.", "approved");

  const slashRequest: SlashRequest = {
    id: makeId("DecisionRecordId", `phase-h-slash-${negativeEvidence.id}`),
    projectId,
    actorId: workerId,
    reason: negativeEvidence.reason,
    severity: "high",
    status: "approved",
    guardianRequestId: String(guardianRequest.id),
    evidenceIds: [negativeEvidence.id],
    createdAt: now,
    updatedAt: new Date().toISOString(),
  };
  fastify.coordinatorStore.saveProjection(SLASH_REQUEST_KIND, slashRequest.id, slashRequest);
  await appendAndPublish(fastify, "SlashRequested", slashRequest, reviewerId, projectId, timeline, "risk", slashRequest.reason, slashRequest.status);

  const run: PhaseHRun = {
    id: makeId("EventId", `phase-h-run-${phaseFRun.id}`),
    projectId,
    phaseFRunId: String(phaseFRun.id),
    rewardIntent: claimableReward,
    positiveEvidence,
    negativeEvidence,
    slashRequest,
    guardianRequest,
    ledger: ledgerSummary(rewardsForProject(fastify, projectId)),
    timeline,
    createdAt: now,
  };
  fastify.coordinatorStore.saveProjection(PHASE_H_RUN_KIND, run.id, run);
  await appendAndPublish(fastify, "PhaseHSmokeCompleted", { projectId, runId: run.id, rewardIntentId: claimableReward.id, slashRequestId: slashRequest.id }, guardianId, projectId, timeline, "phase-h", "Phase H incentive/risk smoke completed", "completed");
  return { ...run, timeline };
}

async function appendAndPublish(
  fastify: Parameters<FastifyPluginAsync>[0],
  type: string,
  payload: object,
  actorId: string,
  projectId: string,
  timeline: PhaseHTimelineEntry[],
  phase: string,
  title: string,
  status: string,
): Promise<void> {
  const payloadRecord = payload as Record<string, unknown>;
  const event = createEvent({ type, actorId: actorId as never, correlationId: projectId as never, payload: { ...payload, projectId } });
  await fastify.concord.state.events.append(event);
  fastify.eventBus.publish(event);
  const entry: PhaseHTimelineEntry = {
    id: makeId("EventId", `phase-h-${phase}-${timeline.length + 1}`),
    projectId,
    phase,
    title,
    status,
    actorId,
    reason: String(payloadRecord.reason ?? title),
    eventType: type,
    entityIds: {
      rewardIntentId: String(payloadRecord.rewardIntentId ?? payloadRecord.id ?? ""),
      slashRequestId: String(payloadRecord.slashRequestId ?? ""),
      guardianRequestId: String(payloadRecord.guardianRequestId ?? ""),
    },
    timestamp: new Date().toISOString(),
  };
  timeline.push(entry);
  const timelineEvent = createEvent({ type: "PhaseHTimelineUpdated", actorId: actorId as never, correlationId: projectId as never, payload: entry });
  fastify.eventBus.publish(timelineEvent);
}

function makeReputationEvidence(projectId: string, actorId: string, kind: ReputationEvidence["kind"], scoreDelta: number, reason: string, source: Record<string, string | undefined>): ReputationEvidence {
  return {
    id: makeId("EventId", `phase-h-reputation-${kind}-${actorId}-${Math.abs(scoreDelta)}`),
    projectId,
    actorId,
    kind,
    scoreDelta,
    reason,
    source,
    createdAt: new Date().toISOString(),
  };
}

function rewardsForProject(fastify: Parameters<FastifyPluginAsync>[0], projectId: string): RewardIntent[] {
  return fastify.coordinatorStore.listProjections<RewardIntent>(REWARD_INTENT_KIND).filter((reward) => reward.projectId === projectId);
}

function reputationForProject(fastify: Parameters<FastifyPluginAsync>[0], projectId: string): ReputationEvidence[] {
  return fastify.coordinatorStore.listProjections<ReputationEvidence>(REPUTATION_EVIDENCE_KIND).filter((item) => item.projectId === projectId);
}

function slashForProject(fastify: Parameters<FastifyPluginAsync>[0], projectId: string): SlashRequest[] {
  return fastify.coordinatorStore.listProjections<SlashRequest>(SLASH_REQUEST_KIND).filter((item) => item.projectId === projectId);
}

function ledgerSummary(intents: RewardIntent[]) {
  return {
    total: intents.length,
    byStatus: {
      draft: intents.filter((reward) => reward.status === "draft").length,
      reserved: intents.filter((reward) => reward.status === "reserved").length,
      claimable: intents.filter((reward) => reward.status === "claimable" || reward.status === "approved").length,
      claimed: intents.filter((reward) => reward.status === "claimed").length,
      cancelled: intents.filter((reward) => reward.status === "cancelled").length,
    },
    recentEntries: intents.slice(-10),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export default phaseHRoutes;
