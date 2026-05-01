import type { FastifyPluginAsync } from "fastify";
import { createEvent, makeId } from "@concord/foundation";
import { ok, okList } from "../../../../domain/apiTypes.js";
import { envelopeKey, errorEnvelope, listEnvelope } from "../../../../domain/schemas.js";
import { GUARDIAN_REQUEST, PROJECT_TIMELINE_ENTRY, REPUTATION_EVIDENCE, REWARD_INTENT, SCENARIO_RUN, SLASH_REQUEST } from "../../../../db/projectionKinds.js";
import { AGENT_COLLABORATION_SCENARIO_ID, runAgentCollaborationScenario } from "../agent-collaboration/routes.js";

const INCENTIVE_RISK_SCENARIO_ID = "incentive-risk";

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

interface ProjectTimelineEntry {
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

interface IncentiveRiskRun {
  id: string;
  projectId: string;
  collaborationRunId: string;
  scenarioId: string;
  rewardIntent: RewardIntent;
  positiveEvidence: ReputationEvidence;
  negativeEvidence: ReputationEvidence;
  slashRequest: SlashRequest;
  guardianRequest: Record<string, unknown>;
  ledger: unknown;
  timeline: ProjectTimelineEntry[];
  createdAt: string;
}

const incentiveRiskScenarioRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/dev/scenarios/incentive-risk/runs", {
    schema: {
      tags: ["Scenarios"],
      summary: "Run incentive-risk dev scenario",
      response: { 200: envelopeKey("run"), 403: errorEnvelope },
    },
  }, async (_request, reply) => {
    if (!fastify.config.enableDevRoutes) {
      return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: "Dev routes disabled" }, meta: { requestId: "req_" + Date.now() } });
    }

    const collaborationRun = await ensureAgentCollaborationRun(fastify);
    const run = await createIncentiveRiskRun(fastify, collaborationRun);
    return ok({ run });
  });

  fastify.get<{ Querystring: { projectId?: string; limit?: string; cursor?: string } }>("/dev/scenarios/incentive-risk/runs", {
    schema: {
      tags: ["Scenarios"],
      summary: "List incentive-risk scenario runs",
      querystring: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          limit: { type: "string" },
          cursor: { type: "string" },
        },
      },
      response: { 200: listEnvelope() },
    },
  }, async (request) => {
    const { projectId, limit: limitStr, cursor } = request.query;
    const limit = Math.min(Number(limitStr) || 50, 200);
    const allIncentiveRuns = await fastify.coordinatorStore.listProjections<IncentiveRiskRun>(SCENARIO_RUN);
    let runs = allIncentiveRuns.filter((run) => run.scenarioId === INCENTIVE_RISK_SCENARIO_ID);
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
};

async function ensureAgentCollaborationRun(fastify: Parameters<FastifyPluginAsync>[0]): Promise<Record<string, unknown>> {
  const collabRuns = await fastify.coordinatorStore.listProjections<Record<string, unknown>>(SCENARIO_RUN);
  const existing = collabRuns.filter((run) => run.scenarioId === AGENT_COLLABORATION_SCENARIO_ID).at(-1);
  if (existing) return existing;
  return runAgentCollaborationScenario(fastify);
}

async function createIncentiveRiskRun(fastify: Parameters<FastifyPluginAsync>[0], collaborationRun: Record<string, unknown>): Promise<IncentiveRiskRun> {
  const projectId = String(collaborationRun.projectId);
  const workOrder = asRecord(collaborationRun.workOrder);
  const review = asRecord(collaborationRun.review);
  const roles = asRecord(collaborationRun.roles);
  const workerId = String(roles.worker ?? asRecord(collaborationRun.submission).submittedBy ?? "worker");
  const reviewerId = String(roles.reviewer ?? review.reviewerId ?? "reviewer");
  const guardianId = String(roles.guardian ?? "guardian");
  const now = new Date().toISOString();
  const timeline: ProjectTimelineEntry[] = [];

  const rewardIntent: RewardIntent = {
    id: makeId("RewardIntentId", `incentive-risk-reward-${workOrder.id ?? collaborationRun.id}`),
    projectId,
    workOrderId: String(workOrder.id ?? ""),
    amount: "100",
    currency: "VIBLY_MOCK",
    recipient: workerId,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  await fastify.coordinatorStore.saveProjection(REWARD_INTENT, rewardIntent.id, rewardIntent);
  await appendAndPublish(fastify, "RewardIntentCreated", rewardIntent, workerId, projectId, timeline, "reward", "Reward intent created for accepted work", "draft");

  const fundingReceipt = await fastify.concord.fundingGateway.reserve({
    amount: rewardIntent.amount,
    currency: rewardIntent.currency,
    recipient: rewardIntent.recipient,
    referenceId: rewardIntent.id,
  });
  const claimableReward: RewardIntent = { ...rewardIntent, status: "claimable", fundingReceipt, updatedAt: new Date().toISOString() };
  await fastify.coordinatorStore.saveProjection(REWARD_INTENT, claimableReward.id, claimableReward);
  await appendAndPublish(fastify, "FundingReserved", { projectId, rewardIntentId: claimableReward.id, fundingReceipt }, workerId, projectId, timeline, "ledger", "Mock funding reserved", "reserved");
  await appendAndPublish(fastify, "RewardClaimable", claimableReward, reviewerId, projectId, timeline, "reward", "Accepted review made the reward claimable", "claimable");

  const positiveEvidence = makeReputationEvidence(projectId, workerId, "positive", 0.2, "Accepted collaboration work produced auditable evidence.", { workOrderId: String(workOrder.id ?? ""), rewardIntentId: claimableReward.id });
  const negativeEvidence = makeReputationEvidence(projectId, workerId, "slash", -0.3, "Injected incentive-risk sample: missing follow-up artifact would justify slash review.", { workOrderId: String(workOrder.id ?? ""), rewardIntentId: claimableReward.id });
  for (const evidence of [positiveEvidence, negativeEvidence]) {
    await fastify.coordinatorStore.saveProjection(REPUTATION_EVIDENCE, evidence.id, evidence);
    await appendAndPublish(fastify, "ReputationEvidenceCreated", evidence, evidence.actorId, projectId, timeline, "reputation", evidence.reason, evidence.kind);
  }

  const guardianRequest = {
    id: makeId("DecisionRecordId", `incentive-risk-guardian-${negativeEvidence.id}`),
    projectId,
    actionId: String(asRecord(collaborationRun.action).id ?? ""),
    requestedBy: reviewerId,
    guardianId,
    status: "approved",
    riskLevel: "high",
    reason: "Slash request requires Guardian visibility before it affects reputation.",
    evidenceIds: [negativeEvidence.id],
  };
  await fastify.coordinatorStore.saveProjection(GUARDIAN_REQUEST, String(guardianRequest.id), guardianRequest);
  await appendAndPublish(fastify, "GuardianReviewRequested", { ...guardianRequest, status: "pending" }, reviewerId, projectId, timeline, "guardian", guardianRequest.reason, "pending");
  await appendAndPublish(fastify, "GuardianReviewCompleted", guardianRequest, guardianId, projectId, timeline, "guardian", "Guardian approved the minimal slash evidence path.", "approved");

  const slashRequest: SlashRequest = {
    id: makeId("DecisionRecordId", `incentive-risk-slash-${negativeEvidence.id}`),
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
  await fastify.coordinatorStore.saveProjection(SLASH_REQUEST, slashRequest.id, slashRequest);
  await appendAndPublish(fastify, "SlashRequested", slashRequest, reviewerId, projectId, timeline, "risk", slashRequest.reason, slashRequest.status);

  const run: IncentiveRiskRun = {
    id: makeId("EventId", `incentive-risk-run-${collaborationRun.id}`),
    projectId,
    collaborationRunId: String(collaborationRun.id),
    scenarioId: INCENTIVE_RISK_SCENARIO_ID,
    rewardIntent: claimableReward,
    positiveEvidence,
    negativeEvidence,
    slashRequest,
    guardianRequest,
    ledger: ledgerSummary(await rewardsForProject(fastify, projectId)),
    timeline,
    createdAt: now,
  };
  await fastify.coordinatorStore.saveProjection(SCENARIO_RUN, run.id, run);
  await appendAndPublish(fastify, "IncentiveRiskScenarioCompleted", { projectId, runId: run.id, rewardIntentId: claimableReward.id, slashRequestId: slashRequest.id }, guardianId, projectId, timeline, "scenario", "Incentive-risk scenario completed", "completed");
  return { ...run, timeline };
}

async function appendAndPublish(
  fastify: Parameters<FastifyPluginAsync>[0],
  type: string,
  payload: object,
  actorId: string,
  projectId: string,
  timeline: ProjectTimelineEntry[],
  phase: string,
  title: string,
  status: string,
): Promise<void> {
  const payloadRecord = payload as Record<string, unknown>;
  const event = createEvent({ type, actorId: actorId as never, correlationId: projectId as never, payload: { ...payload, projectId } });
  await fastify.concord.state.events.append(event);
  fastify.eventBus.publish(event);
  const entry: ProjectTimelineEntry = {
    id: makeId("EventId", `project-timeline-${phase}-${timeline.length + 1}`),
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
  await fastify.coordinatorStore.saveProjection(PROJECT_TIMELINE_ENTRY, entry.id, entry);
  const timelineEvent = createEvent({ type: "ProjectTimelineUpdated", actorId: actorId as never, correlationId: projectId as never, payload: entry });
  fastify.eventBus.publish(timelineEvent);
}

function makeReputationEvidence(projectId: string, actorId: string, kind: ReputationEvidence["kind"], scoreDelta: number, reason: string, source: Record<string, string | undefined>): ReputationEvidence {
  return {
    id: makeId("EventId", `incentive-risk-reputation-${kind}-${actorId}-${Math.abs(scoreDelta)}`),
    projectId,
    actorId,
    kind,
    scoreDelta,
    reason,
    source,
    createdAt: new Date().toISOString(),
  };
}

async function rewardsForProject(fastify: Parameters<FastifyPluginAsync>[0], projectId: string): Promise<RewardIntent[]> {
  const rows = await fastify.coordinatorStore.listProjections<RewardIntent>(REWARD_INTENT);
  return rows.filter((reward) => reward.projectId === projectId);
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

export default incentiveRiskScenarioRoutes;
