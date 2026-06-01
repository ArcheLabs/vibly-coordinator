/**
 * ObservationTaskScheduler — reacts to CoordinationRoundStarted events and
 * creates system observation tasks for the new round.
 *
 * Each round gets one global observation task (kind="observation",
 * systemGenerated=true).  The task deadline is set to
 * round.observationSubmitDeadlineAt so agents know how long they have.
 *
 * The scheduler also emits an ObservationTaskCreated event so the existing
 * ObservationAssignmentProcess can assign an observer via AssignmentOffer.
 */

import { createEvent, makeId } from "@vibly-ai/concord-foundation";
import type { EventBus, Unsubscribe } from "../services/eventBus.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import { WorkRepository } from "../contexts/work/repository.js";
import { RoundRepository } from "../contexts/round/repository.js";
import type { Task } from "../contexts/work/types.js";
import type { CoordinationRound } from "../contexts/round/types.js";

export function startObservationTaskScheduler(
  eventBus: EventBus,
  store: CoordinatorStorePort,
): Unsubscribe {
  return eventBus.subscribe(
    async (env) => {
      const round = env.payload as CoordinationRound;
      if (!round?.id) return;

      try {
        const workRepo = new WorkRepository(store);
        const roundRepo = new RoundRepository(store);

        const now = new Date().toISOString();
        const task: Task = {
          id: makeId("task"),
          organizationId: "global",
          title: `Observation round #${round.roundIndex}`,
          description: `System-generated observation task for coordination round ${round.id}.`,
          status: "available",
          createdBy: "system",
          kind: "observation",
          systemGenerated: true,
          roundId: round.id,
          deadlineAt: round.observationSubmitDeadlineAt,
          createdAt: now,
          updatedAt: now,
        };
        await workRepo.saveTask(task);

        // Update the round with the created task ID.
        const stored = await roundRepo.get(round.id);
        if (stored) {
          await roundRepo.save({
            ...stored,
            createdObservationTaskIds: [...stored.createdObservationTaskIds, task.id],
            updatedAt: now,
          });
        }

        // Emit ObservationTaskCreated so ObservationAssignmentProcess can
        // assign an observer.
        eventBus.publish(
          createEvent({
            type: "ObservationTaskCreated",
            payload: task as unknown as Record<string, unknown>,
            causationId: env.id,
          }),
        );
      } catch (err) {
        console.error("[ObservationTaskScheduler]", err);
      }
    },
    (env) => env.type === "CoordinationRoundStarted",
  );
}
