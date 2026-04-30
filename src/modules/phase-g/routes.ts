import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";

const PHASE_F_RUN_KIND = "phase_f_run";
const GUARDIAN_REQUEST_KIND = "guardian_request";

interface PhaseGRunProjection {
  id: string;
  projectId?: string;
  roles?: Record<string, string>;
  action?: { id?: string; title?: string; riskLevel?: string };
  workOrder?: { id?: string; status?: string; title?: string };
  guardianRequest?: { id?: string; status?: string; reason?: string; riskLevel?: string };
  reviewAggregation?: { result?: string };
  trace?: { traceId?: string };
  verification?: { ok?: boolean };
  replay?: { ok?: boolean };
  timeline?: PhaseGTimelineEntry[];
}

interface PhaseGTimelineEntry {
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

const phaseGRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { projectId: string } }>("/projects/:projectId/phase-g/overview", async (request) => {
    const { projectId } = request.params;
    const [project, objectives, workOrders, events] = await Promise.all([
      fastify.concord.projects.getProject(projectId as never),
      fastify.concord.objectives.listObjectives(projectId as never),
      fastify.concord.work.listWorkOrders(),
      fastify.concord.state.events.query(),
    ]);
    const runs = phaseFRunsForProject(fastify, projectId);
    const guardianRequests = guardianRequestsForProject(fastify, projectId);
    const timeline = buildTimeline(runs, projectId);
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
          phaseFRuns: runs.length,
          openWorkOrders: openWorkOrders.length,
          guardianRequests: guardianRequests.length,
          timelineEvents: timeline.length,
          recentEvents: recentEvents.length,
        },
        latestRun: runs.at(-1) ?? null,
        live: {
          streamPath: `/projects/${projectId}/stream`,
          source: "coordinator_event_bus",
          fallback: "manual_refresh_or_light_polling",
        },
      },
    });
  });

  fastify.get<{ Params: { projectId: string } }>("/projects/:projectId/phase-g/timeline", async (request) => {
    const { projectId } = request.params;
    const runs = phaseFRunsForProject(fastify, projectId);
    return ok({ timeline: buildTimeline(runs, projectId) });
  });
};

function phaseFRunsForProject(fastify: Parameters<FastifyPluginAsync>[0], projectId: string): PhaseGRunProjection[] {
  return fastify.coordinatorStore
    .listProjections<PhaseGRunProjection>(PHASE_F_RUN_KIND)
    .filter((run) => run.projectId === projectId);
}

function guardianRequestsForProject(fastify: Parameters<FastifyPluginAsync>[0], projectId: string) {
  return fastify.coordinatorStore
    .listProjections<{ projectId?: string }>(GUARDIAN_REQUEST_KIND)
    .filter((request) => request.projectId === projectId);
}

function buildTimeline(runs: PhaseGRunProjection[], projectId: string): PhaseGTimelineEntry[] {
  const entries = runs.flatMap((run) => {
    const traceId = run.trace?.traceId;
    return (run.timeline ?? []).map((entry) => ({
      ...entry,
      projectId,
      traceId: entry.traceId ?? traceId,
    }));
  });
  return entries.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
}

export default phaseGRoutes;
