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
        const taskPlanItems = proposal.suggestedTaskPlan.length > 0
          ? proposal.suggestedTaskPlan
          : [{ title: `Work item: ${proposal.title}`, description: proposal.body }];

        const taskPlan = {
          id: makeId("taskplan"),
          organizationId: proposal.organizationId,
          projectId: proposal.projectId,
          proposalId: proposal.id,
          taskCount: taskPlanItems.length,
          createdAt: now,
        };
        eventBus.publish(createEvent({ type: "TaskPlanCreated", payload: taskPlan, causationId: env.id }));

        for (const [index, item] of taskPlanItems.entries()) {
          const raw = item as Record<string, unknown>;
          const task: Task = {
            id: makeId("task"),
            organizationId: proposal.organizationId,
            projectId: proposal.projectId,
            proposalId: proposal.id,
            title: String(raw["title"] ?? raw["name"] ?? `Task ${index + 1}: ${proposal.title}`),
            description: String(raw["description"] ?? raw["acceptanceCriteria"] ?? proposal.body),
            status: "available",
            skillRequirements: Array.isArray(raw["skillRequirements"]) ? raw["skillRequirements"] as string[] : undefined,
            createdBy: proposal.submittedBy,
            createdAt: now,
            updatedAt: now,
          };
          await workRepo.saveTask(task);
          eventBus.publish(createEvent({ type: "TaskCreated", payload: { ...task, taskPlanId: taskPlan.id }, causationId: env.id }));
          eventBus.publish(createEvent({ type: "TaskOpened", payload: { taskId: task.id, organizationId: task.organizationId, projectId: task.projectId }, causationId: env.id }));
        }
      } catch (err) {
        console.error("[ProposalAcceptedProcess]", err);
      }
    },
    (env) => env.type === "ProposalAccepted",
  );
}
