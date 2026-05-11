/**
 * TaskSubmittedProcess — triggers a ReviewRound when a Task is submitted.
 */

import { createEvent, makeId } from "@concord/foundation";
import type { EventBus, Unsubscribe } from "../services/eventBus.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import { WorkRepository } from "../contexts/work/repository.js";
import { ReviewRepository } from "../contexts/evaluation/repository.js";
import { MechanismRepository } from "../contexts/mechanism/repository.js";
import { selectParticipants } from "../contexts/mechanism/mechanismEngine.js";
import { IdentityRepository } from "../contexts/identity/repository.js";
import type { ReviewRound } from "../contexts/evaluation/types.js";

export function startTaskSubmittedProcess(
  eventBus: EventBus,
  store: CoordinatorStorePort,
): Unsubscribe {
  return eventBus.subscribe(
    async (env) => {
      const payload = env.payload as Record<string, unknown>;
      const task = payload["task"] as Record<string, unknown> | undefined;
      const submission = payload["submission"] as Record<string, unknown> | undefined;
      if (!task || !submission) return;

      const taskId = task["id"] as string;
      const submissionId = submission["id"] as string;
      const organizationId = task["organizationId"] as string;

      try {
        const mechRepo = new MechanismRepository(store);
        const identityRepo = new IdentityRepository(store);
        const reviewRepo = new ReviewRepository(store);

        // Find mechanism (if any) from the task
        const allMechanisms = await mechRepo.list(organizationId);
        const mechanism = allMechanisms[0]; // use first available mechanism for org

        const agents = await identityRepo.listAgentProfiles();
        const candidates = agents.map((a) => a.principalId);
        const rule = mechanism?.reviewerSelection ?? { primitive: "random-selection" as const, count: 3 };
        const { selected: reviewerIds } = selectParticipants(rule, { candidates });

        const now = new Date().toISOString();
        const round: ReviewRound = {
          id: makeId("rev"),
          taskId,
          submissionId,
          organizationId,
          targetRef: { type: "TaskSubmission", id: submissionId },
          mechanismId: mechanism?.id,
          reviewerIds,
          reviews: [],
          status: "pending",
          createdAt: now,
          updatedAt: now,
        };
        await reviewRepo.save(round);

        const event = createEvent({ type: "ReviewRoundCreated", payload: { ...round }, causationId: env.id });
        eventBus.publish(event);
      } catch (err) {
        console.error("[TaskSubmittedProcess]", err);
      }
    },
    (env) => env.type === "TaskSubmitted",
  );
}
