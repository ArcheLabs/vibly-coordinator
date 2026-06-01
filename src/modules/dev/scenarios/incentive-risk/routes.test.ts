import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createConcord } from "@concord/sdk";
import type { EventEnvelope } from "@vibly-ai/concord-foundation";
import { loadConfig } from "../../../../config/env.js";
import type { CoordinatorStore } from "../../../../db/coordinatorStore.js";
import type { EventBus } from "../../../../services/eventBus.js";
import agentCollaborationScenarioRoutes from "../agent-collaboration/routes.js";
import guardianRoutes from "../../../incentives/guardian/routes.js";
import projectReadModelRoutes from "../../../project/read-models/routes.js";
import reputationRoutes from "../../../incentives/reputation/routes.js";
import riskRoutes from "../../../incentives/risk/routes.js";
import incentiveRiskScenarioRoutes from "./routes.js";

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

describe("incentive risk scenario routes", () => {
  it("creates reward, reputation, slash, guardian, and overview read models", async () => {
    const fastify = Fastify({ logger: false });
    const store = makeStore();
    const published: Array<EventEnvelope<string, unknown>> = [];
    fastify.decorate("concord", createConcord());
    fastify.decorate("coordinatorStore", store as unknown as CoordinatorStore);
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
    await fastify.register(reputationRoutes);
    await fastify.register(riskRoutes);
    await fastify.register(incentiveRiskScenarioRoutes);

    const response = await fastify.inject({ method: "POST", url: "/dev/scenarios/incentive-risk/runs" });
    expect(response.statusCode).toBe(200);

    const run = response.json<{
      data: {
        run: {
          id: string;
          projectId: string;
          rewardIntent: { status: string; fundingReceipt: unknown };
          positiveEvidence: { kind: string };
          negativeEvidence: { kind: string };
          slashRequest: { status: string; guardianRequestId: string };
          guardianRequest: { status: string };
          timeline: unknown[];
        };
      };
    }>().data.run;

    expect(run.rewardIntent.status).toBe("claimable");
    expect(run.rewardIntent.fundingReceipt).toBeTruthy();
    expect(run.positiveEvidence.kind).toBe("positive");
    expect(run.negativeEvidence.kind).toBe("slash");
    expect(run.slashRequest.status).toBe("approved");
    expect(run.guardianRequest.status).toBe("approved");
    expect(run.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "reward", eventType: "RewardClaimable" }),
      expect.objectContaining({ phase: "reputation", eventType: "ReputationEvidenceCreated" }),
      expect.objectContaining({ phase: "risk", eventType: "SlashRequested" }),
    ]));

    const listResponse = await fastify.inject({ method: "GET", url: "/dev/scenarios/incentive-risk/runs" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<{ data: unknown[] }>().data).toHaveLength(1);

    const overviewResponse = await fastify.inject({ method: "GET", url: `/projects/${run.projectId}/overview` });
    expect(overviewResponse.statusCode).toBe(200);
    expect(overviewResponse.json<{ data: { overview: { counts: { scenarioRuns: number; claimableRewards: number; reputationEvidence: number; slashRequests: number } } } }>().data.overview.counts).toMatchObject({
      scenarioRuns: 2,
      claimableRewards: 1,
      reputationEvidence: 2,
      slashRequests: 1,
    });

    const reputationResponse = await fastify.inject({ method: "GET", url: `/reputation/evidence?projectId=${run.projectId}` });
    expect(reputationResponse.statusCode).toBe(200);
    expect(reputationResponse.json<{ data: unknown[] }>().data).toHaveLength(2);

    const slashResponse = await fastify.inject({ method: "GET", url: `/slash-requests?projectId=${run.projectId}` });
    expect(slashResponse.statusCode).toBe(200);
    expect(slashResponse.json<{ data: unknown[] }>().data).toHaveLength(1);

    expect(published.map((event) => event.type)).toEqual(expect.arrayContaining([
      "RewardIntentCreated",
      "FundingReserved",
      "RewardClaimable",
      "ReputationEvidenceCreated",
      "SlashRequested",
      "IncentiveRiskScenarioCompleted",
      "ProjectTimelineUpdated",
    ]));

    await fastify.close();
  });
});
