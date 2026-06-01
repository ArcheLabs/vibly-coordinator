/**
 * TaskSubmittedProcess — triggers a ReviewRound + initial ReviewCycle (#0)
 * when a Task is submitted.
 */

import { createEvent, makeId } from "@vibly-ai/concord-foundation";
import type { EventBus, Unsubscribe } from "../services/eventBus.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import type { CoordinatorConfig } from "../config/env.js";
import { WorkRepository } from "../contexts/work/repository.js";
import { ReviewRepository, ReviewCycleRepository } from "../contexts/evaluation/repository.js";
import { MechanismRepository } from "../contexts/mechanism/repository.js";
import type { ReviewRound, ReviewCycle } from "../contexts/evaluation/types.js";
import { selectReviewersForCycle } from "../application/reviewerSelection.js";

export function startTaskSubmittedProcess(
  eventBus: EventBus,
  store: CoordinatorStorePort,
  config: CoordinatorConfig,
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
      const submitterId = task["assigneeId"] as string | undefined;
      const proposerId = task["proposalId"] as string | undefined;

      try {
        const mechRepo = new MechanismRepository(store);
        const reviewRepo = new ReviewRepository(store);
        const cycleRepo = new ReviewCycleRepository(store);

        const allMechanisms = await mechRepo.list(organizationId);
        const mechanism = allMechanisms[0];
        const rule = mechanism?.reviewerSelection
          ? {
              primitive: mechanism.reviewerSelection.primitive,
              count: mechanism.reviewerSelection.count,
              minReputation: mechanism.reviewerSelection.minReputation,
              minStake: mechanism.reviewerSelection.minStake,
            }
          : undefined;

        const now = new Date().toISOString();
        const roundId = makeId("rev");
        const cycleId = makeId("cyc");

        // ── Reviewer selection (audit recorded inside) ──────────────────────
        const { selectedIds: reviewerIds, auditId } = await selectReviewersForCycle({
          store,
          config,
          reviewRoundId: roundId,
          reviewCycleId: cycleId,
          cycleIndex: 0,
          submitterId,
          proposerId,
          organizationId,
          rule,
        });

        const cycleDeadline = new Date(Date.now() + config.reviewCycleIntervalMs).toISOString();

        // ── ReviewRound ──────────────────────────────────────────────────────
        const round: ReviewRound = {
          id: roundId,
          taskId,
          submissionId,
          organizationId,
          targetRef: { type: "TaskSubmission", id: submissionId },
          mechanismId: mechanism?.id,
          reviewerIds,
          reviews: [],
          status: "pending",
          currentCycleIndex: 0,
          totalCycles: 1,
          createdAt: now,
          updatedAt: now,
        };
        await reviewRepo.save(round);

        // ── ReviewCycle #0 ───────────────────────────────────────────────────
        const cycle: ReviewCycle = {
          id: cycleId,
          reviewRoundId: roundId,
          cycleIndex: 0,
          taskId,
          submissionId,
          organizationId,
          reviewerIds,
          reviews: [],
          status: "active",
          deadline: cycleDeadline,
          selectionAuditId: auditId,
          createdAt: now,
          updatedAt: now,
        };
        await cycleRepo.save(cycle);

        const roundEvent = createEvent({
          type: "ReviewRoundCreated",
          payload: { ...round },
          causationId: env.id,
        });
        eventBus.publish(roundEvent);

        const cycleEvent = createEvent({
          type: "ReviewCycleStarted",
          payload: { ...cycle },
          causationId: env.id,
        });
        eventBus.publish(cycleEvent);
      } catch (err) {
        console.error("[TaskSubmittedProcess]", err);
      }
    },
    (env) => env.type === "TaskSubmitted",
  );
}
