import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvent } from "@concord/foundation";
import { loadConfig } from "../config/env.js";
import type { ActionIntentDispatcher } from "../application/actionIntentDispatcher.js";
import type { ActionIntent, ActionIntentResult } from "../application/types.js";
import { CoordinationRepository } from "../contexts/coordination/repository.js";
import type { AssignmentOffer } from "../contexts/coordination/types.js";
import type { CoordinatorStorePort, CreateLeaseInput, Lease } from "../db/coordinatorStorePort.js";
import { createInMemoryEventBus } from "../services/eventBus.js";
import { startAssignmentExpiryScheduler } from "./assignmentExpiryScheduler.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("AssignmentExpiryScheduler", () => {
  it("dispatches at the nearest persisted offer expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = makeStore();
    const eventBus = createInMemoryEventBus();
    const dispatch = vi.fn(async (): Promise<ActionIntentResult> => ({
      eventId: "evt-1",
      aggregateRef: { kind: "AssignmentExpiry", id: "tick-1" },
      status: "accepted",
      events: [],
    }));

    await new CoordinationRepository(store).saveAssignmentOffer(makeOffer("assign-1", 1000));
    const stop = startAssignmentExpiryScheduler({
      intervalMs: 10_000,
      principalId: "coordinator",
      dispatcher: { dispatch } as unknown as ActionIntentDispatcher,
      store,
      eventBus,
      concord: {} as never,
      config: loadConfig({ NODE_ENV: "test", API_AUTH_MODE: "none" }),
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledWith(
      { type: "TickAssignmentExpiry", principalId: "coordinator", payload: {} },
      expect.objectContaining({ principalId: "coordinator" }),
    );
    stop();
  });

  it("reschedules when an assignment offer is published after startup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = makeStore();
    const eventBus = createInMemoryEventBus();
    const dispatch = vi.fn(async (): Promise<ActionIntentResult> => ({
      eventId: "evt-1",
      aggregateRef: { kind: "AssignmentExpiry", id: "tick-1" },
      status: "accepted",
      events: [],
    }));

    const stop = startAssignmentExpiryScheduler({
      intervalMs: 10_000,
      principalId: "coordinator",
      dispatcher: { dispatch } as unknown as ActionIntentDispatcher,
      store,
      eventBus,
      concord: {} as never,
      config: loadConfig({ NODE_ENV: "test", API_AUTH_MODE: "none" }),
    });

    const offer = makeOffer("assign-1", 500);
    await new CoordinationRepository(store).saveAssignmentOffer(offer);
    eventBus.publish(createEvent({ type: "AssignmentOffered", payload: offer, actorId: "coordinator" as never }));

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(dispatch).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not dispatch when another instance holds the expiry lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = makeStore({ denyLease: true });
    const eventBus = createInMemoryEventBus();
    const dispatch = vi.fn(async (): Promise<ActionIntentResult> => ({
      eventId: "evt-1",
      aggregateRef: { kind: "AssignmentExpiry", id: "tick-1" },
      status: "accepted",
      events: [],
    }));

    await new CoordinationRepository(store).saveAssignmentOffer(makeOffer("assign-1", 1));
    const stop = startAssignmentExpiryScheduler({
      intervalMs: 10_000,
      principalId: "coordinator",
      dispatcher: { dispatch } as unknown as ActionIntentDispatcher,
      store,
      eventBus,
      concord: {} as never,
      config: loadConfig({ NODE_ENV: "test", API_AUTH_MODE: "none" }),
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).not.toHaveBeenCalled();
    stop();
  });
});

function makeOffer(id: string, delayMs: number): AssignmentOffer {
  return {
    id,
    observationTaskId: "obstask-1",
    assigneeId: "agent-1",
    status: "offered",
    offeredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + delayMs).toISOString(),
  };
}

function makeStore(opts: { denyLease?: boolean } = {}): CoordinatorStorePort {
  const projections = new Map<string, Map<string, unknown>>();
  const leases = new Map<string, Lease>();
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
    async createLease(input: CreateLeaseInput) {
      const lease = makeLease(input);
      leases.set(lease.id, lease);
      return lease;
    },
    async tryAcquireLease(input: CreateLeaseInput) {
      if (opts.denyLease) return undefined;
      const now = new Date().toISOString();
      for (const [id, lease] of leases) {
        if (lease.kind === input.kind && lease.resourceId === input.resourceId && lease.expiresAt <= now) leases.delete(id);
      }
      const active = Array.from(leases.values()).find(
        (lease) => lease.kind === input.kind && lease.resourceId === input.resourceId && lease.expiresAt > now,
      );
      if (active) return undefined;
      const lease = makeLease(input);
      leases.set(lease.id, lease);
      return lease;
    },
    async getLease(id: string) {
      return leases.get(id);
    },
    async getActiveLease(kind: string, resourceId: string) {
      const now = new Date().toISOString();
      return Array.from(leases.values()).find((lease) => lease.kind === kind && lease.resourceId === resourceId && lease.expiresAt > now);
    },
    async renewLease(id: string, ttlMs: number) {
      const lease = leases.get(id);
      if (!lease) return undefined;
      const renewed = { ...lease, expiresAt: new Date(Date.now() + ttlMs).toISOString(), renewedAt: new Date().toISOString() };
      leases.set(id, renewed);
      return renewed;
    },
    async releaseLease(id: string) {
      leases.delete(id);
    },
    async sweepExpiredLeases() {
      return [];
    },
  };
}

function makeLease(input: CreateLeaseInput): Lease {
  return {
    id: `lease-${Math.random().toString(16).slice(2)}`,
    kind: input.kind,
    resourceId: input.resourceId,
    holderId: input.holderId,
    expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
    createdAt: new Date().toISOString(),
  };
}
