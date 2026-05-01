import type { FastifyPluginAsync } from "fastify";
import { GUARDIAN_REQUEST, PROJECT_TIMELINE_ENTRY, REPUTATION_EVIDENCE, REWARD_INTENT, SCENARIO_RUN, SLASH_REQUEST, TRACE } from "../../db/projectionKinds.js";
import { ok } from "../../domain/apiTypes.js";

interface ScenarioRun {
  id: string;
  scenarioId?: string;
  projectId?: string;
  trace?: { traceId?: string };
  timeline?: ProjectTimelineEntry[];
}

interface ProjectTimelineEntry {
  id: string;
  projectId: string;
  traceId?: string;
  phase: string;
  title: string;
  status: string;
  timestamp?: string;
}

interface ProjectScoped {
  id?: string;
  projectId?: string;
  status?: string;
}

const projectReadModelRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { projectId: string } }>("/projects/:projectId/overview", async (request) => {
    const { projectId } = request.params;
    const [project, objectives, workOrders, events] = await Promise.all([
      fastify.concord.projects.getProject(projectId as never),
      fastify.concord.objectives.listObjectives(projectId as never),
      fastify.concord.work.listWorkOrders(),
      fastify.concord.state.events.query(),
    ]);
    const runs = scenarioRunsForProject(fastify, projectId);
    const guardianRequests = projectionsForProject<ProjectScoped>(fastify, GUARDIAN_REQUEST, projectId);
    const rewards = projectionsForProject<ProjectScoped>(fastify, REWARD_INTENT, projectId);
    const reputationEvidence = projectionsForProject<ProjectScoped>(fastify, REPUTATION_EVIDENCE, projectId);
    const slashRequests = projectionsForProject<ProjectScoped>(fastify, SLASH_REQUEST, projectId);
    const runTraceIds = new Set(runs.map((run) => run.trace?.traceId).filter(Boolean));
    const traces = fastify.coordinatorStore
      .listProjections<{ traceId?: string }>(TRACE)
      .filter((trace) => trace.traceId && runTraceIds.has(trace.traceId));
    const timeline = buildTimeline(fastify, runs, projectId);
    const openWorkOrders = workOrders.filter((workOrder) => {
      const candidate = workOrder as unknown as { projectId?: string; status?: string };
      return candidate.projectId === projectId && candidate.status !== "accepted" && candidate.status !== "cancelled" && candidate.status !== "expired";
    });
    const recentEvents = events
      .filter((event) => {
        const payload = event.payload as { projectId?: string } | undefined;
        return payload?.projectId === projectId;
      })
      .slice(-20)
      .reverse();

    return ok({
      overview: {
        project,
        primaryObjective: objectives.find((objective) => objective.id === project?.primaryObjectiveId) ?? objectives[0] ?? null,
        counts: {
          objectives: objectives.length,
          scenarioRuns: runs.length,
          openWorkOrders: openWorkOrders.length,
          guardianRequests: guardianRequests.length,
          rewards: rewards.length,
          claimableRewards: rewards.filter((reward) => reward.status === "claimable" || reward.status === "approved").length,
          reputationEvidence: reputationEvidence.length,
          slashRequests: slashRequests.length,
          traces: traces.length,
          timelineEvents: timeline.length,
          recentEvents: recentEvents.length,
        },
        latestRun: runs.at(-1) ?? null,
        ledger: ledgerSummary(rewards),
        live: {
          streamPath: `/projects/${projectId}/stream`,
          source: "coordinator_event_bus",
          fallback: "manual_refresh_or_light_polling",
        },
      },
    });
  });

  fastify.get<{ Params: { projectId: string } }>("/projects/:projectId/timeline", async (request) => {
    const { projectId } = request.params;
    const runs = scenarioRunsForProject(fastify, projectId);
    return ok({ timeline: buildTimeline(fastify, runs, projectId) });
  });
};

function scenarioRunsForProject(fastify: Parameters<FastifyPluginAsync>[0], projectId: string): ScenarioRun[] {
  return fastify.coordinatorStore
    .listProjections<ScenarioRun>(SCENARIO_RUN)
    .filter((run) => run.projectId === projectId);
}

function projectionsForProject<T extends ProjectScoped>(fastify: Parameters<FastifyPluginAsync>[0], kind: string, projectId: string): T[] {
  return fastify.coordinatorStore
    .listProjections<T>(kind)
    .filter((item) => item.projectId === projectId);
}

function buildTimeline(fastify: Parameters<FastifyPluginAsync>[0], runs: ScenarioRun[], projectId: string): ProjectTimelineEntry[] {
  const projectedEntries = fastify.coordinatorStore
    .listProjections<ProjectTimelineEntry>(PROJECT_TIMELINE_ENTRY)
    .filter((entry) => entry.projectId === projectId);
  const embeddedEntries = runs.flatMap((run) => {
    const traceId = run.trace?.traceId;
    return (run.timeline ?? []).map((entry) => ({
      ...entry,
      projectId,
      traceId: entry.traceId ?? traceId,
    }));
  });
  const entriesById = new Map<string, ProjectTimelineEntry>();
  for (const entry of [...projectedEntries, ...embeddedEntries]) entriesById.set(entry.id, entry);
  return Array.from(entriesById.values()).sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
}

function ledgerSummary(intents: ProjectScoped[]) {
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

export default projectReadModelRoutes;
