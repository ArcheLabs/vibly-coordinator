import type { ActionIntentDispatcher } from "../application/actionIntentDispatcher.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import type { EventBus } from "../services/eventBus.js";
import type { Concord } from "@concord/sdk";
import type { CoordinatorConfig } from "../config/env.js";

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
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await input.dispatcher.dispatch(
        { type: "TickAssignmentExpiry", principalId: input.principalId, payload: {} },
        { store: input.store, eventBus: input.eventBus, concord: input.concord, config: input.config, principalId: input.principalId },
      );
    } catch (err) {
      console.error("[AssignmentExpiryScheduler]", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, input.intervalMs);
  return () => clearInterval(timer);
}
