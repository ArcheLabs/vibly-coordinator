/**
 * RewardCreationProcess — after a TaskAccepted event, auto-creates a
 * RewardIntent for the assignee based on the mechanism's reward rule.
 */

import { createEvent, makeId } from "@vibly-ai/concord-foundation";
import type { EventBus, Unsubscribe } from "../services/eventBus.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import { WorkRepository } from "../contexts/work/repository.js";
import { MechanismRepository } from "../contexts/mechanism/repository.js";
import { SettlementRepository } from "../contexts/settlement/repository.js";
import type { RewardIntent } from "../contexts/settlement/types.js";

export function startRewardCreationProcess(
  eventBus: EventBus,
  store: CoordinatorStorePort,
): Unsubscribe {
  return eventBus.subscribe(
    async (env) => {
      const payload = env.payload as Record<string, unknown>;
      const taskId = payload["id"] as string | undefined;
      const assigneeId = payload["assigneeId"] as string | undefined;
      const organizationId = payload["organizationId"] as string | undefined;
      if (!taskId || !assigneeId || !organizationId) return;

      try {
        const mechRepo = new MechanismRepository(store);
        const settlementRepo = new SettlementRepository(store);

        const mechanisms = await mechRepo.list(organizationId);
        const mechanism = mechanisms[0]; // use first available mechanism for org

        const baseAmount = mechanism?.reward?.base ?? "0";
        if (baseAmount === "0") return; // no reward configured

        const now = new Date().toISOString();
        const vetoWindowMs = 86400000; // 24h default

        const reward: RewardIntent = {
          id: makeId("rwd"),
          organizationId,
          recipientId: assigneeId,
          reason: "Task completed and accepted",
          amount: baseAmount,
          currency: "DOT",
          sourceRef: { type: "Task", id: taskId },
          status: "pending",
          guardianVetoDeadline: new Date(Date.now() + vetoWindowMs).toISOString(),
          createdBy: "system",
          createdAt: now,
          updatedAt: now,
        };
        await settlementRepo.saveRewardIntent(reward);

        const event = createEvent({ type: "RewardIntentCreated", payload: { ...reward }, causationId: env.id });
        eventBus.publish(event);
      } catch (err) {
        console.error("[RewardCreationProcess]", err);
      }
    },
    (env) => env.type === "TaskAccepted",
  );
}
