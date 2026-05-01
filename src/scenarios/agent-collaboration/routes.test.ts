import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createConcord } from "@concord/sdk";
import type { EventEnvelope } from "@concord/foundation";
import { loadConfig } from "../../config/env.js";
import type { CoordinatorStore } from "../../db/coordinatorStore.js";
import type { EventBus } from "../../services/eventBus.js";
import agentCollaborationScenarioRoutes from "./routes.js";
import guardianRoutes from "../../modules/guardian/routes.js";
import projectReadModelRoutes from "../../modules/project-read-models/routes.js";

function makeStore() {
  const projections = new Map<string, Map<string, unknown>>();
  return {
    saveProjection: (kind: string, id: string, value: unknown) => {
      const bucket = projections.get(kind) ?? new Map<string, unknown>();
      bucket.set(id, value);
      projections.set(kind, bucket);
    },
    getProjection: (kind: string, id: string) => projections.get(kind)?.get(id),
    listProjections: (kind: string) => Array.from(projections.get(kind)?.values() ?? []),
  };
}

describe("agent collaboration scenario routes", () => {
  it("runs the test-agent collaboration loop and records traceable read models", async () => {
    const fastify = Fastify({ logger: false });
    const store = makeStore();
    fastify.decorate("concord", createConcord());
    fastify.decorate("coordinatorStore", store as unknown as CoordinatorStore);
    const published: Array<EventEnvelope<string, unknown>> = [];
    fastify.decorate("eventBus", { publish: (event: EventEnvelope<string, unknown>) => { published.push(event); }, subscribe: () => () => {} } as unknown as EventBus);
    fastify.decorate("config", loadConfig({
      NODE_ENV: "test",
      API_AUTH_MODE: "none",
      STORAGE_MODE: "memory",
      ENABLE_DEV_ROUTES: "true",
    }));

    await fastify.register(agentCollaborationScenarioRoutes);
    await fastify.register(guardianRoutes);
    await fastify.register(projectReadModelRoutes);

    const response = await fastify.inject({ method: "POST", url: "/dev/scenarios/agent-collaboration/runs" });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      data: {
        run: {
          action: { riskLevel: string };
          policyDecision: { result: string };
          negotiation: { status: string };
          decisionRecord: { result: string };
          workOrder: { status: string };
          reviewAggregation: { result: string };
          guardianRequest: { status: string; projectId: string };
          timeline: unknown[];
          trace: { traceId: string; snapshots: { humanRequests?: unknown[]; workOrders: unknown[]; reviews: unknown[] } };
          verification: { ok: boolean; invariantResults: Array<{ id: string; status: string }> };
          replay: { ok: boolean };
        };
      };
    }>();
    const run = body.data.run;

    expect(run.action.riskLevel).toBe("high");
    expect(run.policyDecision.result).toBe("requires_negotiation");
    expect(run.negotiation.status).toBe("converged");
    expect(run.decisionRecord.result).toBe("approved");
    expect(run.workOrder.status).toBe("accepted");
    expect(run.reviewAggregation.result).toBe("accepted");
    expect(run.guardianRequest.status).toBe("approved");
    expect(run.trace.snapshots.humanRequests).toHaveLength(2);
    expect(run.trace.snapshots.workOrders).toHaveLength(1);
    expect(run.trace.snapshots.reviews).toHaveLength(1);
    expect(run.verification).toMatchObject({ ok: true, errors: [] });
    expect(run.replay.ok).toBe(true);
    expect(run.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "observe", eventType: "StateObservationSubmitted" }),
      expect.objectContaining({ phase: "guardian", eventType: "GuardianReviewRequested" }),
      expect.objectContaining({ phase: "review", eventType: "ReviewAggregated" }),
      expect.objectContaining({ phase: "knowledge", eventType: "KnowledgeVersionCreated" }),
    ]));
    expect(Object.fromEntries(run.verification.invariantResults.map((result) => [result.id, result.status]))).toMatchObject({
      "action.policy.required": "pass",
      "action.no-work-without-policy": "pass",
      "knowledge.commit.requires-decision": "pass",
      "knowledge.version.has-hash": "pass",
    });

    const guardianResponse = await fastify.inject({ method: "GET", url: "/guardian-requests?status=approved" });
    expect(guardianResponse.statusCode).toBe(200);
    expect(guardianResponse.json<{ data: unknown[] }>().data).toHaveLength(1);

    const listResponse = await fastify.inject({ method: "GET", url: "/dev/scenarios/agent-collaboration/runs" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<{ data: unknown[] }>().data).toHaveLength(1);

    const overviewResponse = await fastify.inject({ method: "GET", url: `/projects/${run.guardianRequest.projectId}/overview` });
    expect(overviewResponse.statusCode).toBe(200);
    expect(overviewResponse.json<{ data: { overview: { counts: { scenarioRuns: number; timelineEvents: number } } } }>().data.overview.counts).toMatchObject({
      scenarioRuns: 1,
      timelineEvents: run.timeline.length,
    });

    const timelineResponse = await fastify.inject({ method: "GET", url: `/projects/${run.guardianRequest.projectId}/timeline` });
    expect(timelineResponse.statusCode).toBe(200);
    expect(timelineResponse.json<{ data: { timeline: unknown[] } }>().data.timeline).toHaveLength(run.timeline.length);

    await expectOldPhaseRoutesToBeGone(fastify, run.guardianRequest.projectId);
    expect(published.map((event) => event.type)).toEqual(expect.arrayContaining([
      "ProjectTimelineUpdated",
      "GuardianReviewRequested",
      "GuardianReviewCompleted",
      "AgentCollaborationScenarioCompleted",
    ]));

    await fastify.close();
  });
});

async function expectOldPhaseRoutesToBeGone(fastify: ReturnType<typeof Fastify>, projectId: string): Promise<void> {
  const oldRoutes = [
    "/phase-f/smoke",
    "/phase-f/runs",
    `/projects/${projectId}/phase-g/overview`,
    "/phase-h/smoke",
  ];
  for (const url of oldRoutes) {
    const response = await fastify.inject({ method: url.endsWith("/smoke") ? "POST" : "GET", url });
    expect(response.statusCode).toBe(404);
  }
}
