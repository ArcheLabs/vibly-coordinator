import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import type { ReputationEvent, AgentReputation } from "./types.js";

const EVENT_KIND = "reputation_event_v2";
const SCORE_KIND = "agent_reputation_v2";

export class ReputationRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async saveEvent(e: ReputationEvent): Promise<void> {
    await this.store.saveProjection(EVENT_KIND, e.id, e);
  }

  async listEvents(principalId?: string, organizationId?: string): Promise<ReputationEvent[]> {
    const all = await this.store.listProjections<ReputationEvent>(EVENT_KIND);
    return all.filter((e) => {
      if (principalId && e.principalId !== principalId) return false;
      if (organizationId && e.organizationId !== organizationId) return false;
      return true;
    });
  }

  async saveScore(r: AgentReputation): Promise<void> {
    const key = `${r.organizationId}:${r.principalId}`;
    await this.store.saveProjection(SCORE_KIND, key, r);
  }

  async getScore(organizationId: string, principalId: string): Promise<AgentReputation | undefined> {
    const key = `${organizationId}:${principalId}`;
    return this.store.getProjection<AgentReputation>(SCORE_KIND, key);
  }

  async listScores(organizationId?: string): Promise<AgentReputation[]> {
    const all = await this.store.listProjections<AgentReputation>(SCORE_KIND);
    return organizationId ? all.filter((r) => r.organizationId === organizationId) : all;
  }
}
