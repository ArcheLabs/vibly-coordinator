import type { ActionIntentDispatcher } from "../application/actionIntentDispatcher.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import type { EventBus } from "../services/eventBus.js";
import type { Concord } from "@concord/sdk";
import type { CoordinatorConfig } from "../config/env.js";
import { CoordinationRepository } from "../contexts/coordination/repository.js";

export function startAssignmentExpiryScheduler(input: {
  intervalMs: number;
  principalId: string;
  dispatcher: ActionIntentDispatcher;
  store: CoordinatorStorePort;
  eventBus: EventBus;
  concord: Concord;
  config: CoordinatorConfig;
}): () => void {
  if (input.intervalMs <= 0) return () => {};
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduling = false;
  let rescheduleRequested = false;
  const leaseTtlMs = Math.max(5000, input.intervalMs * 4);
  let reschedule: (fallbackDelayMs?: number) => Promise<void> = async () => {};

  const tick = async () => {
    if (running) return;
    running = true;
    let lease: Awaited<ReturnType<typeof input.store.tryAcquireLease>>;
    let fallbackDelayMs: number | undefined;
    try {
      lease = await input.store.tryAcquireLease({
        kind: "assignment-expiry",
        resourceId: "global",
        holderId: input.principalId,
        ttlMs: leaseTtlMs,
      });
      if (!lease) {
        fallbackDelayMs = input.intervalMs;
        return;
      }
      await input.dispatcher.dispatch(
        { type: "TickAssignmentExpiry", principalId: input.principalId, payload: {} },
        { store: input.store, eventBus: input.eventBus, concord: input.concord, config: input.config, principalId: input.principalId },
      );
    } catch (err) {
      console.error("[AssignmentExpiryScheduler]", err);
    } finally {
      if (lease) await input.store.releaseLease(lease.id).catch(() => {});
      running = false;
      void reschedule(fallbackDelayMs);
    }
  };

  reschedule = async (fallbackDelayMs?: number): Promise<void> => {
    if (stopped) return;
    if (scheduling) {
      rescheduleRequested = true;
      return;
    }
    scheduling = true;
    try {
      do {
        rescheduleRequested = false;
        if (timer) clearTimeout(timer);
        const delayMs = fallbackDelayMs ?? await nextExpiryDelayMs(input.store);
        if (delayMs === undefined) {
          timer = undefined;
          if (rescheduleRequested) continue;
          return;
        }
        timer = setTimeout(() => { void tick(); }, Math.min(Math.max(delayMs, 0), 2_147_483_647));
      } while (rescheduleRequested);
    } catch (err) {
      console.error("[AssignmentExpiryScheduler]", err);
      timer = setTimeout(() => { void tick(); }, input.intervalMs);
    } finally {
      scheduling = false;
    }
  };

  const unsubscribe = input.eventBus.subscribe(
    () => { void reschedule(); },
    (event) => event.type === "AssignmentOffered" ||
      event.type === "AssignmentAccepted" ||
      event.type === "AssignmentDeclined" ||
      event.type === "AssignmentTimedOut",
  );

  void reschedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

async function nextExpiryDelayMs(store: CoordinatorStorePort): Promise<number | undefined> {
  const repo = new CoordinationRepository(store);
  const now = Date.now();
  const next = (await repo.listAllAssignmentOffers())
    .filter((offer) => offer.status === "offered" && offer.expiresAt != null)
    .map((offer) => Date.parse(offer.expiresAt!))
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b)[0];
  return next === undefined ? undefined : Math.max(0, next - now);
}
