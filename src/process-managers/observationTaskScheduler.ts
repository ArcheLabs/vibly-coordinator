/**
 * ObservationTaskScheduler — reacts to CoordinationRoundStarted events and
 * creates system observation tasks for active projects that are due in the
 * new global round.
 *
 * A project's protocol.observationCycleInterval controls how often it starts
 * observation: n=1 means every global round, n=3 means rounds 3, 6, 9, ...
 * Historical projects without this field are treated as n=1.
 */

import { createEvent, makeId } from "@vibly-ai/concord-foundation";
import type { Project, ProjectService } from "@concord/project";
import type { EventBus, Unsubscribe } from "../services/eventBus.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import { CoordinationRepository } from "../contexts/coordination/repository.js";
import { RoundRepository } from "../contexts/round/repository.js";
import type { CoordinationRound } from "../contexts/round/types.js";
import type { ObservationTask } from "../contexts/coordination/types.js";

export function startObservationTaskScheduler(
  eventBus: EventBus,
  store: CoordinatorStorePort,
  projects: ProjectService,
): Unsubscribe {
  return eventBus.subscribe(
    async (env) => {
      const round = env.payload as CoordinationRound;
      if (!round?.id) return;

      try {
        const coordinationRepo = new CoordinationRepository(store);
        const roundRepo = new RoundRepository(store);
        const now = new Date().toISOString();
        const dueProjects = (await projects.listProjects()).filter((project) =>
          project.status === "active" && isProjectObservationDue(project, round.roundIndex),
        );

        if (dueProjects.length === 0) return;

        const createdTaskIds: string[] = [];
        for (const project of dueProjects) {
          const interval = observationCycleInterval(project);
          const task: ObservationTask = {
            id: makeId("obstask"),
            organizationId: String(project.organizationId),
            projectId: String(project.id),
            title: `Observation round #${round.roundIndex + 1}: ${project.name}`,
            description: `System-generated observation task for project ${project.id} in coordination round ${round.id}. Observation cycle interval: ${interval}.`,
            status: "pending",
            createdBy: "system",
            deadline: round.observationSubmitDeadlineAt,
            createdAt: now,
            updatedAt: now,
          };

          await coordinationRepo.saveObservationTask(task);
          createdTaskIds.push(task.id);

          eventBus.publish(
            createEvent({
              type: "ObservationTaskCreated",
              payload: task as unknown as Record<string, unknown>,
              causationId: env.id,
            }),
          );
        }

        const stored = await roundRepo.get(round.id);
        if (stored) {
          await roundRepo.save({
            ...stored,
            createdObservationTaskIds: [...stored.createdObservationTaskIds, ...createdTaskIds],
            updatedAt: now,
          });
        }
      } catch (err) {
        console.error("[ObservationTaskScheduler]", err);
      }
    },
    (env) => env.type === "CoordinationRoundStarted",
  );
}

function isProjectObservationDue(project: Project, roundIndex: number): boolean {
  return (roundIndex + 1) % observationCycleInterval(project) === 0;
}

function observationCycleInterval(project: Project): number {
  const interval = (project.protocol as { observationCycleInterval?: unknown } | undefined)?.observationCycleInterval;
  return typeof interval === "number" && Number.isInteger(interval) && interval >= 1 ? interval : 1;
}
