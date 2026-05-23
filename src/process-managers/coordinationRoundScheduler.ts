/**
 * CoordinationRoundScheduler — creates global Coordination Rounds on a
 * fixed interval.
 *
 * One active round exists at a time.  When the current round's endsAt
 * passes, the scheduler closes it and opens a new one.
 *
 * Set VIBLY_COORDINATION_ROUND_INTERVAL_MS=0 to disable the scheduler
 * (useful in test environments or when driven by external triggers).
 */

import { createEvent, makeId } from "@concord/foundation";
import type { CoordinatorConfig } from "../config/env.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import type { EventBus } from "../services/eventBus.js";
import { RoundRepository } from "../contexts/round/repository.js";
import type { CoordinationRound } from "../contexts/round/types.js";

export function startCoordinationRoundScheduler(opts: {
  config: CoordinatorConfig;
  store: CoordinatorStorePort;
  eventBus: EventBus;
}): () => void {
  const { config, store, eventBus } = opts;
  const intervalMs = config.viblyCoordinationRoundIntervalMs;

  if (intervalMs === 0) {
    // Scheduler disabled — caller opted out via config.
    return () => {};
  }

  async function tick(): Promise<void> {
    try {
      const repo = new RoundRepository(store);
      const now = Date.now();
      const nowIso = new Date(now).toISOString();

      // Close any expired active round.
      const activeRound = await repo.findActive();
      if (activeRound && new Date(activeRound.endsAt).getTime() <= now) {
        const closed: CoordinationRound = {
          ...activeRound,
          status: "closed",
          updatedAt: nowIso,
        };
        await repo.save(closed);
        eventBus.publish(
          createEvent({ type: "CoordinationRoundClosed", payload: { ...closed } }),
        );
      }

      // Check again — we may have just closed one.
      const stillActive = await repo.findActive();
      if (stillActive) return; // already have an active round

      // Create a new round.
      const latest = await repo.findLatest();
      const nextIndex = (latest?.roundIndex ?? -1) + 1;
      const startedAt = nowIso;
      const endsAt = new Date(now + intervalMs).toISOString();
      const observationSubmitDeadlineAt = new Date(
        now + Math.round(intervalMs * config.observationSubmitRatio),
      ).toISOString();

      const round: CoordinationRound = {
        id: makeId("round"),
        roundIndex: nextIndex,
        startedAt,
        observationSubmitDeadlineAt,
        endsAt,
        status: "active",
        createdObservationTaskIds: [],
        createdAt: startedAt,
        updatedAt: startedAt,
      };
      await repo.save(round);

      eventBus.publish(
        createEvent({ type: "CoordinationRoundStarted", payload: { ...round } }),
      );
    } catch (err) {
      console.error("[CoordinationRoundScheduler]", err);
    }
  }

  // Fire once immediately so a round is ready on startup.
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);

  return () => clearInterval(handle);
}
