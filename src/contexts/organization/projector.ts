/**
 * OrganizationProjector — updates Organization read models in response to
 * domain events published on the EventBus.
 *
 * Call `start(eventBus, repo)` once at application startup.  The returned
 * `Unsubscribe` function should be called on graceful shutdown.
 */

import type { EventBus, Unsubscribe } from "../../services/eventBus.js";
import { OrganizationRepository } from "./repository.js";
import { apply, type OrganizationEvent } from "./aggregate.js";
import type { FeedItem, OrganizationOverview } from "./types.js";

const ORGANIZATION_EVENT_TYPES = new Set([
  "OrganizationCreated",
  "HandbookUpdated",
  "MemberAdded",
  "MemberRemoved",
  "AuthorityGranted",
  "AuthorityRevoked",
  "OrganizationPaused",
  "OrganizationResumed",
]);

function toOverview(org: ReturnType<typeof apply>): OrganizationOverview {
  return {
    id: org.id,
    name: org.name,
    description: org.description,
    chainId: org.chainId,
    status: org.status,
    memberCount: org.members.length,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}

export function startOrganizationProjector(
  eventBus: EventBus,
  repo: OrganizationRepository,
): Unsubscribe {
  return eventBus.subscribe(
    async (env) => {
      const event = { type: env.type, payload: env.payload } as OrganizationEvent;
      const organizationId = (env.payload as Record<string, unknown>)["organizationId"] as string | undefined
        ?? (env.payload as Record<string, unknown>)["id"] as string | undefined;

      if (!organizationId) return;

      try {
        const current = await repo.get(organizationId);
        const next = apply(current, event);
        await repo.save(next);
        await repo.saveOverview(toOverview(next));

        // Append to feed for key events
        const feedTypes = new Set([
          "OrganizationCreated",
          "HandbookUpdated",
          "MemberAdded",
          "MemberRemoved",
          "AuthorityGranted",
          "AuthorityRevoked",
          "OrganizationPaused",
          "OrganizationResumed",
        ]);
        if (feedTypes.has(event.type)) {
          const feedItem: FeedItem = {
            feedEventId: env.id,
            eventType: event.type,
            networkId: next.chainId,
            chainId: next.chainId,
            organizationId,
            actorId: typeof env.actorId === "string" ? env.actorId : undefined,
            summary: `${event.type} on ${organizationId}`,
            payload: env.payload as Record<string, unknown>,
            createdAt: env.timestamp.iso,
          };
          await repo.appendFeedItem(feedItem);
        }
      } catch (err) {
        // Log but do not crash the event bus handler
        console.error("[OrganizationProjector]", err);
      }
    },
    (env) => ORGANIZATION_EVENT_TYPES.has(env.type),
  );
}
