/**
 * ProposalAcceptedProcess — when a Proposal is accepted, creates a Task
 * that captures the work agreed upon.
 */

import { createEvent, makeId } from "@concord/foundation";
import type { EventBus, Unsubscribe } from "../services/eventBus.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import { CoordinationRepository } from "../contexts/coordination/repository.js";
import { WorkRepository } from "../contexts/work/repository.js";
import type { Task } from "../contexts/work/types.js";

export function startProposalAcceptedProcess(
  eventBus: EventBus,
  store: CoordinatorStorePort,
): Unsubscribe {
  return eventBus.subscribe(
    async (env) => {
      const payload = env.payload as Record<string, unknown>;
      const proposalId = payload["proposalId"] as string | undefined;
      if (!proposalId) return;

      try {
        const coordRepo = new CoordinationRepository(store);
        const workRepo = new WorkRepository(store);

        const proposal = await coordRepo.getProposal(proposalId);
        if (!proposal) return;

        const now = new Date().toISOString();
        const task: Task = {
          id: makeId("task"),
          organizationId: proposal.organizationId,
          projectId: proposal.projectId,
          proposalId: proposal.id,
          title: `Work item: ${proposal.title}`,
          description: proposal.body,
          status: "available",
          createdBy: proposal.submittedBy,
          createdAt: now,
          updatedAt: now,
        };
        await workRepo.saveTask(task);

        const event = createEvent({ type: "TaskCreated", payload: { ...task }, causationId: env.id });
        eventBus.publish(event);
      } catch (err) {
        console.error("[ProposalAcceptedProcess]", err);
      }
    },
    (env) => env.type === "ProposalAccepted",
  );
}
