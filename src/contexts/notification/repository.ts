import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import { AGENT_NOTIFICATION, AGENT_NOTIFICATION_SEQUENCE } from "../../db/projectionKinds.js";
import type { AgentNotification, AgentNotificationSequence } from "./types.js";

export class NotificationRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async save(notification: AgentNotification): Promise<void> {
    await this.store.saveProjection(AGENT_NOTIFICATION, notification.id, notification);
  }

  async get(id: string): Promise<AgentNotification | undefined> {
    return this.store.getProjection<AgentNotification>(AGENT_NOTIFICATION, id);
  }

  async listForAgent(agentId: string, sinceSequence?: number): Promise<AgentNotification[]> {
    const all = await this.store.listProjections<AgentNotification>(AGENT_NOTIFICATION);
    return all
      .filter((n) => n.agentId === agentId && (sinceSequence == null || n.sequence > sinceSequence))
      .sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Returns the next monotonically increasing sequence number for the given
   * agent and atomically increments the stored counter.
   * Safe for single-instance deployments; add a DB advisory lock for multi-replica.
   */
  async nextSequence(agentId: string): Promise<number> {
    const key = `seq:${agentId}`;
    const existing = await this.store.getProjection<AgentNotificationSequence>(
      AGENT_NOTIFICATION_SEQUENCE,
      key,
    );
    const next = (existing?.nextSequence ?? 0) + 1;
    const now = new Date().toISOString();
    await this.store.saveProjection(AGENT_NOTIFICATION_SEQUENCE, key, {
      agentId,
      nextSequence: next,
      updatedAt: now,
    } satisfies AgentNotificationSequence);
    return next;
  }
}
