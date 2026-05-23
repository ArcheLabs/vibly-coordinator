import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import { AGENT_OBLIGATION } from "../../db/projectionKinds.js";
import type { AgentObligation, ObligationKind, ObligationStatus } from "./types.js";

export interface ObligationFilter {
  agentId?: string;
  kind?: ObligationKind;
  status?: ObligationStatus;
  reviewCycleId?: string;
  taskId?: string;
}

export class ObligationRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async save(obligation: AgentObligation): Promise<void> {
    await this.store.saveProjection(AGENT_OBLIGATION, obligation.id, obligation);
  }

  async get(id: string): Promise<AgentObligation | undefined> {
    return this.store.getProjection<AgentObligation>(AGENT_OBLIGATION, id);
  }

  async list(filter?: ObligationFilter): Promise<AgentObligation[]> {
    const all = await this.store.listProjections<AgentObligation>(AGENT_OBLIGATION);
    if (!filter) return all;
    return all.filter((o) => {
      if (filter.agentId && o.agentId !== filter.agentId) return false;
      if (filter.kind && o.kind !== filter.kind) return false;
      if (filter.status && o.status !== filter.status) return false;
      if (filter.reviewCycleId && o.reviewCycleId !== filter.reviewCycleId) return false;
      if (filter.taskId && o.taskId !== filter.taskId) return false;
      return true;
    });
  }
}
