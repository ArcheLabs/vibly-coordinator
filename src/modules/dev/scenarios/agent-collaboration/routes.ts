import type { FastifyPluginAsync } from "fastify";
import type { Actor } from "@concord/core";
import type { EventEnvelope } from "@concord/foundation";
import type { Agent, Principal, Project, Objective, RuntimeBinding } from "@concord/project";
import { createEvent, makeId, sha256, withDeterministicMode } from "@concord/foundation";
import { ok, okList } from "../../../../domain/apiTypes.js";
import { envelopeKey, errorEnvelope, listEnvelope } from "../../../../domain/schemas.js";
import { GUARDIAN_REQUEST, PROJECT_TIMELINE_ENTRY, SCENARIO_RUN, TRACE } from "../../../../db/projectionKinds.js";

interface AgentCollaborationSeed {
  key: "observer" | "delegate" | "worker" | "reviewer" | "guardian";
  displayName: string;
  role: "observer" | "delegate" | "member" | "reviewer" | "guardian";
  kind: Actor["kind"];
  capability: string;
}

export const AGENT_COLLABORATION_SCENARIO_ID = "agent-collaboration";
const AGENT_COLLABORATION_PROJECT_SLUG = "agent-collaboration";
const AGENTS: AgentCollaborationSeed[] = [
  { key: "observer", displayName: "Observer Agent", role: "observer", kind: "agent", capability: "agent-collaboration.observe" },
  { key: "delegate", displayName: "Delegate Agent", role: "delegate", kind: "agent", capability: "agent-collaboration.negotiate" },
  { key: "worker", displayName: "Worker Agent", role: "member", kind: "agent", capability: "agent-collaboration.execute" },
  { key: "reviewer", displayName: "Reviewer Agent", role: "reviewer", kind: "agent", capability: "agent-collaboration.review" },
  { key: "guardian", displayName: "Guardian Agent", role: "guardian", kind: "guardian", capability: "agent-collaboration.guardian" },
];

export interface ProjectTimelineEntry {
  id: string;
  projectId: string;
  actionId?: string;
  traceId?: string;
  phase: string;
  title: string;
  status: string;
  actorId?: string;
  reason?: string;
  evidence?: unknown;
  eventType: string;
  entityIds?: Record<string, string | undefined>;
  timestamp?: string;
}

const agentCollaborationScenarioRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/dev/scenarios/agent-collaboration/runs", {
    schema: {
      tags: ["Scenarios"],
      summary: "Run agent-collaboration dev scenario",
      response: { 200: envelopeKey("run"), 403: errorEnvelope },
    },
  }, async (_request, reply) => {
    if (!fastify.config.enableDevRoutes) {
      return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: "Dev routes disabled" }, meta: { requestId: "req_" + Date.now() } });
    }

    const run = await runAgentCollaborationScenario(fastify);
    return ok({ run });
  });

  fastify.get<{ Querystring: { limit?: string; cursor?: string } }>("/dev/scenarios/agent-collaboration/runs", {
    schema: {
      tags: ["Scenarios"],
      summary: "List agent-collaboration scenario runs",
      querystring: {
        type: "object",
        properties: { limit: { type: "string" }, cursor: { type: "string" } },
      },
      response: { 200: listEnvelope() },
    },
  }, async (request) => {
    const { limit: limitStr, cursor } = request.query;
    const limit = Math.min(Number(limitStr) || 50, 200);
    const allRuns = await fastify.coordinatorStore.listProjections<{ id: string; scenarioId?: string }>(SCENARIO_RUN);
    const runs = allRuns.filter((run) => run.scenarioId === AGENT_COLLABORATION_SCENARIO_ID);
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

export async function runAgentCollaborationScenario(fastify: Parameters<FastifyPluginAsync>[0]) {
  const beforeEvents = await fastify.concord.state.events.query();
  const result = await withDeterministicMode(
    { seed: "agent-collaboration-smoke", startIso: "2026-01-01T00:00:00.000Z" },
    () => runAgentCollaborationWorkflow(fastify),
  );
  const events = (await fastify.concord.state.events.query()).slice(beforeEvents.length);
  const trace = await withDeterministicMode(
    { seed: "agent-collaboration-trace", startIso: "2026-01-01T00:10:00.000Z" },
    () => createTrace(events, result.project.id),
  );
  const verification = await verifyTrace(trace);
  const replay = await replayTrace(trace);

  const run = {
    id: result.action.id,
    scenarioId: AGENT_COLLABORATION_SCENARIO_ID,
    projectId: result.project.id,
    projectSlug: result.project.slug,
    objectiveId: result.objective.id,
    roles: Object.fromEntries(Object.entries(result.actors).map(([role, actor]) => [role, actor.id])),
    action: result.action,
    policyDecision: result.policyDecision,
    negotiation: result.negotiation,
    decisionRecord: result.decisionRecord,
    workOrder: result.workOrder,
    submission: result.submission,
    review: result.review,
    reviewAggregation: result.reviewAggregation,
    knowledgeCandidate: result.knowledgeCandidate,
    knowledgeVersion: result.knowledgeVersion,
    stateView: result.stateView,
    guardianRequest: result.guardianRequest,
    timeline: result.timeline.map((entry) => ({ ...entry, traceId: trace.traceId })),
    trace,
    verification,
    replay,
  };

  await fastify.coordinatorStore.saveProjection(SCENARIO_RUN, run.id, run);
  await fastify.coordinatorStore.saveProjection(TRACE, trace.traceId, trace);
  await fastify.coordinatorStore.saveProjection(GUARDIAN_REQUEST, result.guardianRequest.id, result.guardianRequest);

  const completed = createEvent({
    type: "AgentCollaborationScenarioCompleted",
    correlationId: result.action.id,
    payload: { projectId: result.project.id, runId: run.id, traceId: trace.traceId, verificationOk: verification.ok, replayOk: replay.ok },
  });
  await fastify.concord.state.events.append(completed);
  fastify.eventBus.publish(completed);

  return run;
}

async function runAgentCollaborationWorkflow(fastify: Parameters<FastifyPluginAsync>[0]) {
  const principals = new Map<AgentCollaborationSeed["key"] | "sponsor", Principal>();
  const agents = new Map<AgentCollaborationSeed["key"], Agent>();
  const runtimeBindings = new Map<AgentCollaborationSeed["key"], RuntimeBinding>();
  const timeline: ProjectTimelineEntry[] = [];

  const sponsor = await ensurePrincipal(fastify, "Agent Collaboration Sponsor", "human");
  principals.set("sponsor", sponsor);
  await ensureInitialKnowledge(fastify, sponsor);

  for (const seed of AGENTS) {
    const principal = await ensurePrincipal(fastify, `${seed.displayName} Principal`, "service");
    const agent = await ensureAgent(fastify, principal, seed);
    principals.set(seed.key, principal);
    agents.set(seed.key, agent);
    if (seed.key === "worker" && !agent.defaultRuntimeBindingId) {
      runtimeBindings.set(seed.key, await fastify.concord.agents.createRuntimeBinding({
        agentId: agent.id,
        runtimeKind: "script" as never,
        runtimeAdapterId: "mock-runtime",
        capabilities: [{ name: "agent-collaboration.execute" }] as never,
      }));
    }
  }

  const actors = await ensureActors(fastify, agents);
  const { project, objective } = await ensureProjectAndObjective(fastify, sponsor, agents);

  await fastify.concord.policies.registerPolicy({
    policy: {
      id: makeId("ActionPolicyId", "agent-collaboration-coordinate-agent-task"),
      version: { value: "1.0.0" },
      actionType: "coordinate_agent_task",
      eligibility: [],
      requiredContext: [],
      decisionFlow: "structured_negotiation",
      votingRule: { quorum: 1, threshold: 0.5 },
      produces: ["work_order", "review"] as never,
      resultBinding: "binding",
    },
    decisionRecord: {
      id: makeId("DecisionRecordId", "agent-collaboration-policy-seed"),
      source: "manual",
      result: "approved",
      summary: "Seed agent collaboration policy.",
      approvals: [],
      rejections: [],
      abstentions: [],
      unresolvedIssues: [],
      outputArtifacts: [],
      createdAt: { iso: new Date().toISOString() },
    },
  });

  const goal = await fastify.concord.goals.create({
    id: makeId("GoalId", "agent-collaboration-goal"),
    title: "Run a test-agent collaboration loop",
    description: "Demonstrate Observer, Delegate, Worker, Reviewer, and Guardian collaboration.",
    createdBy: actors.observer.id,
  });
  const contextBundle = await fastify.concord.context.createBundle({
    goalId: goal.id,
    actorId: actors.observer.id,
  });
  const contextReceipt = await fastify.concord.context.acceptBundle({ actorId: actors.observer.id, contextBundleId: contextBundle.id });

  await appendAndPublish(fastify, createEvent({
    type: "StateObservationSubmitted",
    actorId: actors.observer.id,
    correlationId: goal.id,
    payload: { summary: "Observer identified the need for an auditable collaboration smoke.", projectId: project.id },
  }));
  await publishTimeline(fastify, timeline, {
    projectId: project.id,
    phase: "observe",
    title: "Observer identified a collaboration smoke goal",
    status: "observed",
    actorId: actors.observer.id,
    reason: "The scenario needs an auditable collaboration loop.",
    eventType: "StateObservationSubmitted",
    entityIds: { goalId: goal.id, objectiveId: objective.id },
  });

  const action = await fastify.concord.actions.propose({
    type: "coordinate_agent_task",
    proposedBy: actors.observer.id,
    goalId: goal.id,
    title: "Run agent collaboration smoke",
    description: "Coordinate the test agents to produce, submit, and review a traceable artifact.",
    riskLevel: "high",
    context: contextReceipt,
    inputs: [{ uri: "scenario://agent-collaboration/observation/collaboration-smoke" }],
    expectedOutputs: [{ description: "Accepted work order, review aggregation, guardian request, and trace" }],
  });
  const policyDecision = await fastify.concord.actions.evaluate({ action, actor: actors.observer, context: contextBundle });
  await publishTimeline(fastify, timeline, {
    projectId: project.id,
    actionId: action.id,
    phase: "action",
    title: action.title,
    status: policyDecision.result,
    actorId: actors.observer.id,
    reason: "High-risk action requires structured negotiation and Guardian visibility.",
    eventType: "ActionPolicyEvaluated",
    entityIds: { actionId: action.id, goalId: goal.id },
  });

  const guardianRequest = {
    id: makeId("DecisionRecordId", `guardian-request-${action.id}`),
    actionId: action.id,
    projectId: project.id,
    requestedBy: actors.observer.id,
    guardianId: actors.guardian.id,
    status: "pending",
    riskLevel: action.riskLevel,
    reason: "High-risk collaboration smoke requires Guardian visibility.",
  };
  await fastify.coordinatorStore.saveProjection(GUARDIAN_REQUEST, guardianRequest.id, guardianRequest);
  await appendAndPublish(fastify, createEvent({
    type: "GuardianReviewRequested",
    actorId: actors.observer.id,
    correlationId: action.id,
    payload: guardianRequest,
  }));
  await publishTimeline(fastify, timeline, {
    projectId: project.id,
    actionId: action.id,
    phase: "guardian",
    title: "Guardian review requested",
    status: guardianRequest.status,
    actorId: actors.observer.id,
    reason: guardianRequest.reason,
    eventType: "GuardianReviewRequested",
    entityIds: { actionId: action.id, guardianRequestId: guardianRequest.id },
  });

  let negotiation = await fastify.concord.negotiation.create({
    action,
    protocolId: "simple-structured-negotiation",
    participants: [actors.delegate, actors.guardian],
    context: contextReceipt,
    convergenceThreshold: 0.7,
  });
  negotiation = await fastify.concord.negotiation.submitPosition({
    negotiationId: negotiation.id,
    position: { actorId: actors.delegate.id, stance: "support", score: 0.9, rationale: "The task is scoped and traceable.", evidence: [] },
  });
  negotiation = await fastify.concord.negotiation.submitPosition({
    negotiationId: negotiation.id,
    position: { actorId: actors.guardian.id, stance: "support", score: 0.8, rationale: "Risk is acceptable because the path remains scripted and observable.", evidence: [] },
  });
  const { decision: decisionRecord, instance: closedNegotiation } = await fastify.concord.negotiation.close({ negotiationId: negotiation.id, projectId: project.id });
  await publishTimeline(fastify, timeline, {
    projectId: project.id,
    actionId: action.id,
    phase: "negotiate",
    title: "Delegate and Guardian reached a structured decision",
    status: closedNegotiation.status,
    actorId: actors.delegate.id,
    reason: decisionRecord.summary,
    evidence: closedNegotiation,
    eventType: "NegotiationClosed",
    entityIds: { actionId: action.id, negotiationId: closedNegotiation.id, decisionRecordId: decisionRecord.id },
  });
  const completedGuardianRequest = { ...guardianRequest, decisionRecordId: decisionRecord.id, status: "approved" };

  await fastify.coordinatorStore.saveProjection(GUARDIAN_REQUEST, completedGuardianRequest.id, completedGuardianRequest);
  await appendAndPublish(fastify, createEvent({
    type: "GuardianReviewCompleted",
    actorId: actors.guardian.id,
    correlationId: action.id,
    payload: completedGuardianRequest,
  }));
  await publishTimeline(fastify, timeline, {
    projectId: project.id,
    actionId: action.id,
    phase: "guardian",
    title: "Guardian approved the high-risk collaboration action",
    status: completedGuardianRequest.status,
    actorId: actors.guardian.id,
    reason: "Guardian accepted the scripted and observable risk path.",
    eventType: "GuardianReviewCompleted",
    entityIds: { actionId: action.id, guardianRequestId: completedGuardianRequest.id, decisionRecordId: decisionRecord.id },
  });

  const workOrder = await fastify.concord.work.createWorkOrder({
    actionId: action.id,
    goalId: goal.id,
    projectId: project.id,
    objectiveId: objective.id,
    title: "Execute agent collaboration smoke",
    description: "Worker produces a deterministic artifact for Reviewer validation.",
    requiredCapabilities: [{ id: "mock.execute" }],
    contextBundleId: contextBundle.id,
  });
  await fastify.concord.work.claim({ actorId: actors.worker.id, workOrderId: workOrder.id });
  await publishTimeline(fastify, timeline, {
    projectId: project.id,
    actionId: action.id,
    phase: "work",
    title: workOrder.title,
    status: "claimed",
    actorId: actors.worker.id,
    reason: "Worker claimed the deterministic collaboration work order.",
    eventType: "WorkOrderClaimed",
    entityIds: { actionId: action.id, workOrderId: workOrder.id },
  });
  const execution = await fastify.concord.runtime.execute({ actorId: actors.worker.id, runtimeId: "mock-runtime", workOrder, context: contextBundle });
  const submission = await fastify.concord.work.submit({
    workOrderId: workOrder.id,
    submittedBy: actors.worker.id,
    contextReceipt: execution.executionReceipt.inputContext,
    executionReceipt: execution.executionReceipt,
    artifacts: execution.submissionDraft.artifacts,
    summary: "Worker completed the scripted collaboration task and produced an auditable artifact.",
  });
  await publishTimeline(fastify, timeline, {
    projectId: project.id,
    actionId: action.id,
    phase: "work",
    title: "Worker submitted the scripted collaboration artifact",
    status: "submitted",
    actorId: actors.worker.id,
    reason: submission.summary,
    evidence: submission.artifacts,
    eventType: "WorkSubmitted",
    entityIds: { actionId: action.id, workOrderId: workOrder.id, submissionId: submission.id },
  });
  await fastify.concord.review.requestReview({ target: { kind: "submission", submissionId: submission.id }, requestedBy: actors.worker.id });
  const review = await fastify.concord.review.submitReview({
    target: { kind: "submission", submissionId: submission.id },
    reviewerId: actors.reviewer.id,
    result: "accept",
    score: 0.95,
    rationale: "Submission includes execution receipt and artifact evidence.",
    evidence: submission.artifacts,
    contextReceipt,
  });
  const reviewAggregation = await fastify.concord.review.aggregate({ target: { kind: "submission", submissionId: submission.id } });
  await publishTimeline(fastify, timeline, {
    projectId: project.id,
    actionId: action.id,
    phase: "review",
    title: "Reviewer accepted the worker submission",
    status: reviewAggregation.result,
    actorId: actors.reviewer.id,
    reason: review.rationale,
    evidence: reviewAggregation,
    eventType: "ReviewAggregated",
    entityIds: { actionId: action.id, workOrderId: workOrder.id, submissionId: submission.id, reviewId: review.id },
  });
  const acceptedWorkOrder = await fastify.concord.work.accept(workOrder.id);
  const parentKnowledgeVersion = await fastify.concord.knowledge.getLatestVersion();
  const knowledgeCandidate = {
    id: makeId("KnowledgeCandidateId", `agent-collaboration-candidate-${submission.id}`),
    proposedBy: actors.reviewer.id,
    source: { uri: `scenario://agent-collaboration/submissions/${submission.id}`, hash: sha256(submission) },
    summary: "Agent collaboration loop completed and reviewed.",
    targetLayer: "formal" as const,
    context: contextReceipt,
  };
  await fastify.concord.knowledge.saveCandidate(knowledgeCandidate);
  await appendAndPublish(fastify, createEvent({
    type: "KnowledgeCandidateCreated",
    actorId: actors.reviewer.id,
    correlationId: action.id,
    payload: knowledgeCandidate,
  }));
  if (!parentKnowledgeVersion) throw new Error("Missing parent knowledge version for agent collaboration scenario");
  const knowledgeVersion = await fastify.concord.knowledge.commit({
    candidateIds: [knowledgeCandidate.id],
    decisionRecordId: decisionRecord.id,
    parentVersionId: parentKnowledgeVersion.id,
    createdBy: actors.reviewer.id,
  });
  await appendAndPublish(fastify, createEvent({
    type: "KnowledgeCommitted",
    actorId: actors.reviewer.id,
    correlationId: action.id,
    payload: {
      id: knowledgeVersion.commitIds.at(-1),
      candidateIds: [knowledgeCandidate.id],
      decisionRecordId: decisionRecord.id,
      parentVersionId: parentKnowledgeVersion.id,
    },
  }));
  await appendAndPublish(fastify, createEvent({
    type: "KnowledgeVersionCreated",
    actorId: actors.reviewer.id,
    correlationId: action.id,
    payload: knowledgeVersion,
  }));
  await publishTimeline(fastify, timeline, {
    projectId: project.id,
    actionId: action.id,
    phase: "knowledge",
    title: "Reviewed work committed into knowledge state",
    status: "committed",
    actorId: actors.reviewer.id,
    reason: "Accepted collaboration evidence became knowledge state.",
    eventType: "KnowledgeVersionCreated",
    entityIds: { actionId: action.id, knowledgeVersionId: knowledgeVersion.id },
  });
  const stateView = await fastify.concord.state.refresh(knowledgeVersion.id);

  return {
    principals: Object.fromEntries(principals),
    agents: Object.fromEntries(agents),
    runtimeBindings: Object.fromEntries(runtimeBindings),
    actors,
    project,
    objective,
    goal,
    contextBundle,
    action,
    policyDecision,
    guardianRequest: completedGuardianRequest,
    timeline,
    negotiation: closedNegotiation,
    decisionRecord,
    workOrder: acceptedWorkOrder,
    submission,
    review,
    reviewAggregation,
    knowledgeCandidate,
    knowledgeVersion,
    stateView,
  };
}

async function appendAndPublish(fastify: Parameters<FastifyPluginAsync>[0], event: EventEnvelope<string, unknown>): Promise<void> {
  await fastify.concord.state.events.append(event);
  fastify.eventBus.publish(event);
}

async function publishTimeline(fastify: Parameters<FastifyPluginAsync>[0], timeline: ProjectTimelineEntry[], input: Omit<ProjectTimelineEntry, "id" | "timestamp">): Promise<void> {
  const timestamp = new Date().toISOString();
  const entry: ProjectTimelineEntry = {
    ...input,
    id: makeId("EventId", `project-timeline-${input.phase}-${timeline.length + 1}`),
    timestamp,
  };
  timeline.push(entry);
  await fastify.coordinatorStore.saveProjection(PROJECT_TIMELINE_ENTRY, entry.id, entry);
  fastify.eventBus.publish(createEvent({
    type: "ProjectTimelineUpdated",
    actorId: input.actorId as never,
    correlationId: input.actionId as never,
    payload: entry,
  }));
}

async function ensurePrincipal(fastify: Parameters<FastifyPluginAsync>[0], displayName: string, kind: Principal["kind"]): Promise<Principal> {
  const existing = (await fastify.concord.principals.listPrincipals()).find((principal) => principal.displayName === displayName);
  if (existing) return existing;
  return fastify.concord.principals.registerPrincipal({
    kind,
    displayName,
    identityBindings: kind === "human" ? [{ namespace: "scenario", subject: displayName.toLowerCase().replace(/\s+/g, "-") }] : [],
  });
}

async function ensureAgent(fastify: Parameters<FastifyPluginAsync>[0], principal: Principal, seed: AgentCollaborationSeed): Promise<Agent> {
  const existing = (await fastify.concord.agents.listAgents()).find((agent) => agent.displayName === seed.displayName);
  if (existing) return existing;
  return fastify.concord.agents.registerAgent({
    principalId: principal.id,
    displayName: seed.displayName,
    eligibleRoles: [seed.role] as never,
    capabilities: [{ name: seed.capability }] as never,
    metadata: { scenario: AGENT_COLLABORATION_SCENARIO_ID, role: seed.role },
  });
}

async function ensureActors(fastify: Parameters<FastifyPluginAsync>[0], agents: Map<AgentCollaborationSeed["key"], Agent>) {
  const entries = await Promise.all(
    AGENTS.map(async (seed) => {
      const agent = agents.get(seed.key);
      if (!agent) throw new Error(`Missing agent collaboration actor: ${seed.key}`);
      const existing = await fastify.concord.actors.get(agent.id as never);
      const actor = existing ?? await fastify.concord.actors.register({
        id: agent.id as never,
        kind: seed.kind,
        displayName: seed.displayName,
        identities: [{ namespace: "agent", subject: agent.id }],
        capabilities: [{ id: seed.capability }],
      });
      return [seed.key, actor] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<AgentCollaborationSeed["key"], Actor>;
}

async function ensureProjectAndObjective(fastify: Parameters<FastifyPluginAsync>[0], sponsor: Principal, agents: Map<AgentCollaborationSeed["key"], Agent>): Promise<{ project: Project; objective: Objective }> {
  let project = await fastify.concord.projects.getProjectBySlug(AGENT_COLLABORATION_PROJECT_SLUG);
  if (!project) {
    project = await fastify.concord.projects.createProject({
      slug: AGENT_COLLABORATION_PROJECT_SLUG,
      name: "Agent Collaboration Demo",
      description: "Demonstrate scripted agent collaboration with traceable work and review.",
      sponsorPrincipalId: sponsor.id,
      boundary: {
        createdBy: sponsor.id,
        defaultRiskLevel: "medium",
        prohibitedActions: [],
        riskRules: [{ id: "agent-collaboration-risk-high-impact", actionType: "coordinate_agent_task", riskLevel: "high", reason: "Agent coordination affects project state and requires explicit review." }],
        escalationRules: [{ id: "agent-collaboration-guardian-escalation", actionType: "coordinate_agent_task", requiredFlow: "guardian_review", reason: "High-impact test-agent coordination must be visible to Guardian." }],
      },
    });
  }

  let objective = (await fastify.concord.objectives.listObjectives(project.id)).find((candidate) => candidate.title === "Complete a scripted collaboration loop");
  if (!objective) {
    objective = await fastify.concord.objectives.createObjective({
      projectId: project.id,
      kind: "milestone",
      title: "Complete a scripted collaboration loop",
      description: "Agents coordinate to observe, negotiate, execute, and review a task.",
      successCriteria: [
        { id: "sc-loop-complete", description: "A work order is accepted after review.", verificationMethod: "agent_review", required: true },
        { id: "sc-trace", description: "A protocol trace verifies and replays.", verificationMethod: "manual", required: true },
      ],
      createdBy: sponsor.id,
    });
    objective = await fastify.concord.objectives.activateObjective({ objectiveId: objective.id, actorId: sponsor.id });
  }

  if (!project.primaryObjectiveId) {
    project = await fastify.concord.objectives.setPrimaryObjective({ projectId: project.id, objectiveId: objective.id, actorId: sponsor.id });
  }
  if (project.status !== "active") {
    project = await fastify.concord.projects.activateProject({ projectId: project.id, actorId: sponsor.id, reason: "Agent collaboration scenario seed" });
  }

  for (const seed of AGENTS) {
    const agent = agents.get(seed.key);
    if (!agent) continue;
    const existingMembership = (await fastify.concord.agents.listProjectMembers(project.id)).find((membership) => membership.agentId === agent.id);
    if (!existingMembership) {
      await fastify.concord.agents.addProjectMember({
        projectId: project.id,
        principalId: agent.principalId,
        agentId: agent.id,
        roles: [seed.role] as never,
        source: "scenario",
      });
    }
  }

  return { project, objective };
}

async function ensureInitialKnowledge(fastify: Parameters<FastifyPluginAsync>[0], sponsor: Principal): Promise<void> {
  if (await fastify.concord.knowledge.getLatestVersion()) return;
  const knowledge = fastify.concord.knowledge as typeof fastify.concord.knowledge & {
    seedInitialVersion(input: { id: ReturnType<typeof makeId<"KnowledgeVersionId">>; createdBy: string; seed: unknown }): Promise<unknown>;
  };
  await knowledge.seedInitialVersion({
    id: makeId("KnowledgeVersionId", "agent-collaboration-bootstrap"),
    createdBy: sponsor.id,
    seed: { scenarioId: AGENT_COLLABORATION_SCENARIO_ID },
  });
}

async function createTrace(events: unknown[], projectId: string) {
  const { DefaultTraceRecorder } = await import("@concord/trace");
  const recorder = new DefaultTraceRecorder();
  await recorder.start({
    traceId: makeId("TraceId", "trace_agent_collaboration_smoke"),
    scenario: { scenarioId: AGENT_COLLABORATION_SCENARIO_ID, scenarioName: "Agent Collaboration Smoke", scenarioHash: sha256({ projectId }) },
    environment: { runtime: "node", store: "memory", coordinator: "fastify", deterministic: false },
  });
  const normalizedEvents = events.map((event) => normalizeEvent(event));
  for (const event of normalizedEvents) await recorder.recordEvent(event);
  return recorder.finish({
    snapshots: {
      knowledgeVersions: normalizedEvents
        .filter((event) => isEventType(event, "KnowledgeVersionCreated"))
        .map((event) => event.payload),
    },
  });
}

async function verifyTrace(trace: unknown) {
  const { DefaultTraceVerifier } = await import("@concord/trace");
  return new DefaultTraceVerifier().verify(trace as never);
}

async function replayTrace(trace: unknown) {
  const { DefaultTraceReplayer } = await import("@concord/trace");
  return new DefaultTraceReplayer().replay(trace as never);
}

function isEventType(event: unknown, type: string): event is { type: string; payload: unknown } {
  return Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === type);
}

function normalizeEvent(event: unknown): EventEnvelope<string, unknown> {
  const input = event as EventEnvelope<string, unknown>;
  return createEvent({
    id: input.id,
    type: input.type,
    version: input.version,
    timestamp: input.timestamp,
    actorId: input.actorId,
    causationId: input.causationId,
    correlationId: input.correlationId,
    payload: structuredClone(input.payload),
  });
}

export default agentCollaborationScenarioRoutes;
