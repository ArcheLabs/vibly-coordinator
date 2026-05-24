/**
 * OrganizationMembershipNotificationProcess — reacts to MemberAdded /
 * MemberRemoved domain events published on the EventBus and writes
 * AgentNotification records for the affected principal.
 *
 * Only processes events whose payload carries a `member` (join) or
 * `principalId` (remove) field so it can correlate back to an agentId.
 */

import { makeId } from "@concord/foundation";
import type { EventBus, Unsubscribe } from "../services/eventBus.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import { IdentityRepository } from "../contexts/identity/repository.js";
import { NotificationRepository } from "../contexts/notification/repository.js";

export function startOrganizationMembershipNotificationProcess(
  eventBus: EventBus,
  store: CoordinatorStorePort,
): Unsubscribe {
  return eventBus.subscribe(async (env) => {
    const type = env.type as string;
    if (
      type !== "MemberAdded" &&
      type !== "MemberRemoved" &&
      type !== "OrganizationDissolved"
    ) {
      return;
    }

    const payload = env.payload as Record<string, unknown>;

    try {
      const identityRepo = new IdentityRepository(store);
      const notifRepo = new NotificationRepository(store);

      // Resolve principalId from event payload shape
      let principalId: string | undefined;
      if (type === "MemberAdded") {
        const member = payload["member"] as Record<string, unknown> | undefined;
        principalId = member?.["principalId"] as string | undefined;
      } else if (type === "MemberRemoved") {
        principalId = payload["principalId"] as string | undefined;
      } else if (type === "OrganizationDissolved") {
        // No single principal — no personal notification for dissolve
        return;
      }

      if (!principalId) return;

      // Look up agentId from identity context
      const profile = await identityRepo.getAgentProfile(principalId);
      if (!profile) return; // agent not registered — skip

      const notifType =
        type === "MemberAdded" ? ("organization_joined" as const) : ("organization_removed" as const);

      const organizationId = payload["organizationId"] as string | undefined;
      const now = new Date().toISOString();
      const sequence = await notifRepo.nextSequence(profile.principalId);

      await notifRepo.save({
        id: makeId("notif"),
        sequence,
        agentId: profile.principalId,
        type: notifType,
        payload: {
          organizationId,
          principalId,
          joinMode: (payload["member"] as Record<string, unknown> | undefined)?.["joinMode"],
          role: (payload["member"] as Record<string, unknown> | undefined)?.["role"],
          removedAt: payload["removedAt"],
        },
        status: "created",
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      // Do not let notification failures bubble up and affect the primary flow
      console.error("[OrganizationMembershipNotificationProcess] error writing notification", err);
    }
  });
}
