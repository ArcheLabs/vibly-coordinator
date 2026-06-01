/**
 * ObservationAssignmentProcess — reacts to ObservationTaskCreated events,
 * selects an observer via MechanismEngine, and creates an AssignmentOffer.
 *
 * NOTE: This runs in-process via the EventBus.  It is not persistent;
 * process restart may miss events produced while offline.  A persistent
 * job queue (e.g. pg-boss) should be added in a later phase for production.
 */

import { createEvent, makeId } from "@vibly-ai/concord-foundation";
import type { EventBus, Unsubscribe } from "../services/eventBus.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import { CoordinationRepository } from "../contexts/coordination/repository.js";
import { MechanismRepository } from "../contexts/mechanism/repository.js";
import { IdentityRepository } from "../contexts/identity/repository.js";
import { selectParticipants } from "../contexts/mechanism/mechanismEngine.js";
import type { AssignmentOffer } from "../contexts/coordination/types.js";
import { filterEligibleAgents } from "../application/agentEligibility.js";

export function startObservationAssignmentProcess(
  eventBus: EventBus,
  store: CoordinatorStorePort,
): Unsubscribe {
  return eventBus.subscribe(
    async (env) => {
      const payload = env.payload as Record<string, unknown>;
      const taskId = (payload["id"] ?? payload["observationTaskId"]) as string | undefined;
      if (!taskId) return;

      try {
        const coordRepo = new CoordinationRepository(store);
        const mechanismRepo = new MechanismRepository(store);
        const identityRepo = new IdentityRepository(store);

        const task = await coordRepo.getObservationTask(taskId);
        if (!task || task.status !== "pending") return;

        // Resolve mechanism (if specified)
        const mechanism = task.mechanismId ? await mechanismRepo.get(task.mechanismId) : undefined;
        const rule = mechanism?.observerSelection;

        // Get candidate agents from the organization
        const agents = await filterEligibleAgents(store, await identityRepo.listAgentProfiles(), rule);
        const timedOutAssignees = (await coordRepo.listAllAssignmentOffers())
          .filter((offer) => offer.observationTaskId === taskId && offer.status === "timed-out")
          .map((offer) => offer.assigneeId);
        let candidates = agents.map((a) => a.principalId).filter((id) => !timedOutAssignees.includes(id));

        if (candidates.length === 0) {
          // No eligible candidates — mark task as pending (will retry or escalate)
          return;
        }

        const { selected } = selectParticipants(rule ?? { primitive: "random-selection", count: 1 }, { candidates });
        if (selected.length === 0) return;

        const assigneeId = selected[0]!;
        const now = new Date().toISOString();
        const expiresAt = mechanism?.timeout
          ? new Date(Date.now() + mechanism.timeout.durationMs).toISOString()
          : undefined;

        const offer: AssignmentOffer = {
          id: makeId("assign"),
          observationTaskId: taskId,
          assigneeId,
          status: "offered",
          offeredAt: now,
          expiresAt,
        };
        await coordRepo.saveAssignmentOffer(offer);

        // Update task status
        await coordRepo.saveObservationTask({ ...task, status: "assigned", assigneeId, updatedAt: now });

        const offerEvent = createEvent({
          type: "AssignmentOffered",
          payload: { ...offer },
          causationId: env.id,
        });
        eventBus.publish(offerEvent);
      } catch (err) {
        console.error("[ObservationAssignmentProcess]", err);
      }
    },
    (env) => env.type === "ObservationTaskCreated" || env.type === "AssignmentTimedOut",
  );
}
