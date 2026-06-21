import { describe, expect, it } from "vitest";
import { createEvent } from "@vibly-ai/concord-foundation";
import type { ProjectService } from "@concord/project";
import { CoordinationRepository } from "../contexts/coordination/repository.js";
import { RoundRepository } from "../contexts/round/repository.js";
import type { CoordinationRound } from "../contexts/round/types.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import { createInMemoryEventBus } from "../services/eventBus.js";
import { startObservationTaskScheduler } from "./observationTaskScheduler.js";

describe("ObservationTaskScheduler", () => {
  it("creates project-scoped observation tasks on each project's configured cycle", async () => {
    const store = makeStore();
    const eventBus = createInMemoryEventBus();
    const publishedTaskProjectIds: string[] = [];
    eventBus.subscribe((event) => {
      const payload = event.payload as { projectId?: string };
      if (event.type === "ObservationTaskCreated" && payload.projectId) publishedTaskProjectIds.push(payload.projectId);
    });

    startObservationTaskScheduler(eventBus, store, {
      listProjects: async () => [
        makeProject("project-every-round", 1),
        makeProject("project-every-two-rounds", 2),
        makeProject("project-historical-default"),
        makeProject("project-paused", 1, "paused"),
      ],
    } as unknown as ProjectService);

    const rounds = new RoundRepository(store);
    await rounds.save(makeRound("round-1", 0));
    eventBus.publish(createEvent({ type: "CoordinationRoundStarted", payload: makeRound("round-1", 0) }));
    await flushAsyncHandlers();

    const coordination = new CoordinationRepository(store);
    let tasks = await coordination.listObservationTasks();
    expect(tasks.map((task) => task.projectId).sort()).toEqual([
      "project-every-round",
      "project-historical-default",
    ]);
    expect(tasks.every((task) => task.status === "pending")).toBe(true);
    expect(tasks.every((task) => task.deadline === "2026-01-01T00:30:00.000Z")).toBe(true);
    expect((await rounds.get("round-1"))?.createdObservationTaskIds).toHaveLength(2);

    await rounds.save(makeRound("round-2", 1));
    eventBus.publish(createEvent({ type: "CoordinationRoundStarted", payload: makeRound("round-2", 1) }));
    await flushAsyncHandlers();

    tasks = await coordination.listObservationTasks();
    expect(tasks.map((task) => task.projectId).sort()).toEqual([
      "project-every-round",
      "project-every-round",
      "project-every-two-rounds",
      "project-historical-default",
      "project-historical-default",
    ]);
    expect((await rounds.get("round-2"))?.createdObservationTaskIds).toHaveLength(3);
    expect(publishedTaskProjectIds.sort()).toEqual(tasks.map((task) => task.projectId).sort());
  });
});

function makeProject(id: string, observationCycleInterval?: number, status = "active") {
  return {
    id,
    organizationId: "org-1",
    slug: id,
    name: id,
    status,
    protocol: observationCycleInterval === undefined ? undefined : { observationCycleInterval },
  };
}

function makeRound(id: string, roundIndex: number): CoordinationRound {
  return {
    id,
    roundIndex,
    startedAt: "2026-01-01T00:00:00.000Z",
    observationSubmitDeadlineAt: "2026-01-01T00:30:00.000Z",
    endsAt: "2026-01-01T01:00:00.000Z",
    status: "active",
    createdObservationTaskIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeStore(): CoordinatorStorePort {
  const projections = new Map<string, Map<string, unknown>>();
  return {
    async saveProjection(kind: string, id: string, value: unknown) {
      const bucket = projections.get(kind) ?? new Map<string, unknown>();
      bucket.set(id, value);
      projections.set(kind, bucket);
    },
    async getProjection(kind: string, id: string) {
      return (projections.get(kind)?.get(id) ?? undefined) as never;
    },
    async listProjections(kind: string) {
      return Array.from(projections.get(kind)?.values() ?? []) as never;
    },
    async deleteProjection(kind: string, id: string) {
      projections.get(kind)?.delete(id);
    },
    async createLease() {
      throw new Error("not implemented");
    },
    async tryAcquireLease() {
      throw new Error("not implemented");
    },
    async getLease() {
      return undefined;
    },
    async getActiveLease() {
      return undefined;
    },
    async renewLease() {
      return undefined;
    },
    async releaseLease() {},
    async sweepExpiredLeases() {
      return [];
    },
  };
}

async function flushAsyncHandlers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
