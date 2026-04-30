import type { FastifyPluginAsync } from "fastify";
import type { Actor } from "@concord/core";
import type { EventEnvelope } from "@concord/foundation";
import type { Agent, Principal, Project, Objective, RuntimeBinding } from "@concord/project";
import { createEvent, makeId, sha256, withDeterministicMode } from "@concord/foundation";
import { ok, okList } from "../../domain/apiTypes.js";

interface PhaseFAgentSeed {
  key: "observer" | "delegate" | "worker" | "reviewer" | "guardian";
  displayName: string;
  role: "observer" | "delegate" | "member" | "reviewer" | "guardian";
  kind: Actor["kind"];
  capability: string;
}

const PHASE_F_PROJECT_SLUG = "phase-f-collaboration";
const PHASE_F_RUN_KIND = "phase_f_run";
const GUARDIAN_REQUEST_KIND = "guardian_request";
const AGENTS: PhaseFAgentSeed[] = [
  { key: "observer", displayName: "Observer Agent", role: "observer", kind: "agent", capability: "phase-f.observe" },
  { key: "delegate", displayName: "Delegate Agent", role: "delegate", kind: "agent", capability: "phase-f.negotiate" },
  { key: "worker", displayName: "Worker Agent", role: "member", kind: "agent", capability: "phase-f.execute" },
  { key: "reviewer", displayName: "Reviewer Agent", role: "reviewer", kind: "agent", capability: "phase-f.review" },
  { key: "guardian", displayName: "Guardian Agent", role: "guardian", kind: "guardian", capability: "phase-f.guardian" },
];

const phaseFRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/phase-f/smoke", async (_request, reply) => {
    if (!fastify.config.enableDevRoutes) {
      return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: "Dev routes disabled" }, meta: { requestId: "req_" + Date.now() } });
    }

    const beforeEvents = await fastify.concord.state.events.query();
    const result = await withDeterministicMode(
      { seed: "phase-f-smoke", startIso: "2026-01-01T00:00:00.000Z" },
      () => runPhaseFSmoke(fastify),
    );
    const events = (await fastify.concord.state.events.query()).slice(beforeEvents.length);
    const trace = await withDeterministicMode(
      { seed: "phase-f-trace", startIso: "2026-01-01T00:10:00.000Z" },
      () => createTrace(events, result.project.id),
    );
    const verification = await verifyTrace(trace);
    const replay = await replayTrace(trace);

    const run = {
      id: result.action.id,
      scenarioId: "phase-f-agent-collaboration",
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
      trace,
      verification,
      replay,
    };

    fastify.coordinatorStore.saveProjection(PHASE_F_RUN_KIND, run.id, run);
    fastify.coordinatorStore.saveProjection("trace", trace.traceId, trace);
    fastify.coordinatorStore.saveProjection(GUARDIAN_REQUEST_KIND, result.guardianRequest.id, result.guardianRequest);

    const completed = createEvent({
      type: "PhaseFSmokeCompleted",
      correlationId: result.action.id,
      payload: { runId: run.id, traceId: trace.traceId, verificationOk: verification.ok, replayOk: replay.ok },
    });
    await fastify.concord.state.events.append(completed);
    fastify.eventBus.publish(completed);

    return ok({ run });
  });

  fastify.get<{ Querystring: { limit?: string; cursor?: string } }>("/phase-f/runs", async (request) => {
    const { limit: limitStr, cursor } = request.query;
    const limit = Math.min(Number(limitStr) || 50, 200);
    const runs = fastify.coordinatorStore.listProjections<{ id: string }>(PHASE_F_RUN_KIND);
    let startIdx = 0;
    if (cursor) {
      const idx = runs.findIndex((run) => run.id === cursor);
      if (idx !== -1) startIdx = idx + 1;
    }
    const page = runs.slice(startIdx, startIdx + limit);
    const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
    return okList(page, { limit, nextCursor });
  });

  fastify.get<{ Querystring: { projectId?: string; actionId?: string; status?: string; limit?: string; cursor?: string } }>("/guardian-requests", async (request) => {
    const { projectId, actionId, status, limit: limitStr, cursor } = request.query;
    const limit = Math.min(Number(limitStr) || 50, 200);
    let requests = fastify.coordinatorStore.listProjections<{ id: string; projectId?: string; actionId?: string; status?: string }>(GUARDIAN_REQUEST_KIND);
    if (projectId) requests = requests.filter((guardianRequest) => guardianRequest.projectId === projectId);
    if (actionId) requests = requests.filter((guardianRequest) => guardianRequest.actionId === actionId);
    if (status) requests = requests.filter((guardianRequest) => guardianRequest.status === status);
    let startIdx = 0;
    if (cursor) {
      const idx = requests.findIndex((guardianRequest) => guardianRequest.id === cursor);
      if (idx !== -1) startIdx = idx + 1;
    }
    const page = requests.slice(startIdx, startIdx + limit);
    const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
    return okList(page, { limit, nextCursor });
  });
};

async function runPhaseFSmoke(fastify: Parameters<FastifyPluginAsync>[0]) {
  const principals = new Map<PhaseFAgentSeed["key"] | "sponsor", Principal>();
  const agents = new Map<PhaseFAgentSeed["key"], Agent>();
  const runtimeBindings = new Map<PhaseFAgentSeed["key"], RuntimeBinding>();

  const sponsor = await ensurePrincipal(fastify, "Phase F Sponsor", "human");
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
        capabilities: [{ name: "phase-f.execute" }] as never,
      }));
    }
  }

  const actors = await ensureActors(fastify, agents);
  const { project, objective } = await ensureProjectAndObjective(fastify, sponsor, agents);

  await fastify.concord.policies.registerPolicy({
    policy: {
      id: makeId("ActionPolicyId", "phase-f-coordinate-agent-task"),
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
      id: makeId("DecisionRecordId", "phase-f-policy-seed"),
      source: "manual",
      result: "approved",
      summary: "Seed Phase F collaboration policy.",
      approvals: [],
      rejections: [],
      abstentions: [],
      unresolvedIssues: [],
      outputArtifacts: [],
      createdAt: { iso: new Date().toISOString() },
    },
  });

  const goal = await fastify.concord.goals.create({
    id: makeId("GoalId", "phase-f-goal"),
    title: "Run a test-agent collaboration loop",
    description: "Demonstrate Observer, Delegate, Worker, Reviewer, and Guardian collaboration.",
    createdBy: actors.observer.id,
  });
  const contextBundle = await fastify.concord.context.createBundle({
    goalId: goal.id,
    actorId: actors.observer.id,
  });
  const contextReceipt = await fastify.concord.context.acceptBundle({ actorId: actors.observer.id, contextBundleId: contextBundle.id });

  await fastify.concord.state.events.append(createEvent({
    type: "StateObservationSubmitted",
    actorId: actors.observer.id,
    correlationId: goal.id,
    payload: { summary: "Observer identified that Phase F needs an auditable collaboration smoke.", projectId: project.id },
  }));

  const action = await fastify.concord.actions.propose({
    type: "coordinate_agent_task",
    proposedBy: actors.observer.id,
    goalId: goal.id,
    title: "Run Phase F collaboration smoke",
    description: "Coordinate the test agents to produce, submit, and review a traceable artifact.",
    riskLevel: "high",
    context: contextReceipt,
    inputs: [{ uri: "phase-f://observation/collaboration-smoke" }],
    expectedOutputs: [{ description: "Accepted work order, review aggregation, guardian request, and trace" }],
  });
  const policyDecision = await fastify.concord.actions.evaluate({ action, actor: actors.observer, context: contextBundle });

  const guardianRequest = {
    id: makeId("DecisionRecordId", `guardian-request-${action.id}`),
    actionId: action.id,
    projectId: project.id,
    requestedBy: actors.observer.id,
    guardianId: actors.guardian.id,
    status: "pending",
    riskLevel: action.riskLevel,
    reason: "High-risk Phase F collaboration smoke requires Guardian visibility.",
  };
  await fastify.concord.state.events.append(createEvent({
    type: "GuardianReviewRequested",
    actorId: actors.observer.id,
    correlationId: action.id,
    payload: guardianRequest,
  }));

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
  const completedGuardianRequest = { ...guardianRequest, decisionRecordId: decisionRecord.id, status: "approved" };

  await fastify.concord.state.events.append(createEvent({
    type: "GuardianReviewCompleted",
    actorId: actors.guardian.id,
    correlationId: action.id,
    payload: completedGuardianRequest,
  }));

  const workOrder = await fastify.concord.work.createWorkOrder({
    actionId: action.id,
    goalId: goal.id,
    projectId: project.id,
    objectiveId: objective.id,
    title: "Execute Phase F collaboration smoke",
    description: "Worker produces a deterministic artifact for Reviewer validation.",
    requiredCapabilities: [{ id: "mock.execute" }],
    contextBundleId: contextBundle.id,
  });
  await fastify.concord.work.claim({ actorId: actors.worker.id, workOrderId: workOrder.id });
  const execution = await fastify.concord.runtime.execute({ actorId: actors.worker.id, runtimeId: "mock-runtime", workOrder, context: contextBundle });
  const submission = await fastify.concord.work.submit({
    workOrderId: workOrder.id,
    submittedBy: actors.worker.id,
    contextReceipt: execution.executionReceipt.inputContext,
    executionReceipt: execution.executionReceipt,
    artifacts: execution.submissionDraft.artifacts,
    summary: "Worker completed the scripted collaboration task and produced an auditable artifact.",
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
  const acceptedWorkOrder = await fastify.concord.work.accept(workOrder.id);
  const parentKnowledgeVersion = await fastify.concord.knowledge.getLatestVersion();
  const knowledgeCandidate = {
    id: makeId("KnowledgeCandidateId", `phase-f-candidate-${submission.id}`),
    proposedBy: actors.reviewer.id,
    source: { uri: `phase-f://submissions/${submission.id}`, hash: sha256(submission) },
    summary: "Phase F collaboration loop completed and reviewed.",
    targetLayer: "formal" as const,
    context: contextReceipt,
  };
  await fastify.concord.knowledge.saveCandidate(knowledgeCandidate);
  await fastify.concord.state.events.append(createEvent({
    type: "KnowledgeCandidateCreated",
    actorId: actors.reviewer.id,
    correlationId: action.id,
    payload: knowledgeCandidate,
  }));
  if (!parentKnowledgeVersion) throw new Error("Missing parent knowledge version for Phase F smoke");
  const knowledgeVersion = await fastify.concord.knowledge.commit({
    candidateIds: [knowledgeCandidate.id],
    decisionRecordId: decisionRecord.id,
    parentVersionId: parentKnowledgeVersion.id,
    createdBy: actors.reviewer.id,
  });
  await fastify.concord.state.events.append(createEvent({
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
  await fastify.concord.state.events.append(createEvent({
    type: "KnowledgeVersionCreated",
    actorId: actors.reviewer.id,
    correlationId: action.id,
    payload: knowledgeVersion,
  }));
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

async function ensurePrincipal(fastify: Parameters<FastifyPluginAsync>[0], displayName: string, kind: Principal["kind"]): Promise<Principal> {
  const existing = (await fastify.concord.principals.listPrincipals()).find((principal) => principal.displayName === displayName);
  if (existing) return existing;
  return fastify.concord.principals.registerPrincipal({
    kind,
    displayName,
    identityBindings: kind === "human" ? [{ namespace: "scenario", subject: displayName.toLowerCase().replace(/\s+/g, "-") }] : [],
  });
}

async function ensureAgent(fastify: Parameters<FastifyPluginAsync>[0], principal: Principal, seed: PhaseFAgentSeed): Promise<Agent> {
  const existing = (await fastify.concord.agents.listAgents()).find((agent) => agent.displayName === seed.displayName);
  if (existing) return existing;
  return fastify.concord.agents.registerAgent({
    principalId: principal.id,
    displayName: seed.displayName,
    eligibleRoles: [seed.role] as never,
    capabilities: [{ name: seed.capability }] as never,
    metadata: { phase: "F", role: seed.role },
  });
}

async function ensureActors(fastify: Parameters<FastifyPluginAsync>[0], agents: Map<PhaseFAgentSeed["key"], Agent>) {
  const entries = await Promise.all(
    AGENTS.map(async (seed) => {
      const agent = agents.get(seed.key);
      if (!agent) throw new Error(`Missing Phase F agent: ${seed.key}`);
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
  return Object.fromEntries(entries) as Record<PhaseFAgentSeed["key"], Actor>;
}

async function ensureProjectAndObjective(fastify: Parameters<FastifyPluginAsync>[0], sponsor: Principal, agents: Map<PhaseFAgentSeed["key"], Agent>): Promise<{ project: Project; objective: Objective }> {
  let project = await fastify.concord.projects.getProjectBySlug(PHASE_F_PROJECT_SLUG);
  if (!project) {
    project = await fastify.concord.projects.createProject({
      slug: PHASE_F_PROJECT_SLUG,
      name: "Phase F Collaboration Demo",
      description: "Demonstrate scripted agent collaboration with traceable work and review.",
      sponsorPrincipalId: sponsor.id,
      boundary: {
        createdBy: sponsor.id,
        defaultRiskLevel: "medium",
        prohibitedActions: [],
        riskRules: [{ id: "phase-f-risk-high-impact", actionType: "coordinate_agent_task", riskLevel: "high", reason: "Agent coordination affects project state and requires explicit review." }],
        escalationRules: [{ id: "phase-f-guardian-escalation", actionType: "coordinate_agent_task", requiredFlow: "guardian_review", reason: "High-impact test-agent coordination must be visible to Guardian." }],
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
    project = await fastify.concord.projects.activateProject({ projectId: project.id, actorId: sponsor.id, reason: "Phase F smoke seed" });
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
    id: makeId("KnowledgeVersionId", "phase-f-bootstrap"),
    createdBy: sponsor.id,
    seed: { scenarioId: "phase-f-agent-collaboration" },
  });
}

async function createTrace(events: unknown[], projectId: string) {
  const { DefaultTraceRecorder } = await import("@concord/trace");
  const recorder = new DefaultTraceRecorder();
  await recorder.start({
    traceId: makeId("TraceId", "trace_phase_f_smoke"),
    scenario: { scenarioId: "phase-f-agent-collaboration", scenarioName: "Phase F Collaboration Smoke", scenarioHash: sha256({ projectId }) },
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

export default phaseFRoutes;
