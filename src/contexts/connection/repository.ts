import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import { AGENT_CONNECTION_STATUS } from "../../db/projectionKinds.js";
import type { AgentConnectionState } from "./types.js";

export class ConnectionRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async save(state: AgentConnectionState): Promise<void> {
    await this.store.saveProjection(AGENT_CONNECTION_STATUS, state.agentId, state);
  }

  async get(agentId: string): Promise<AgentConnectionState | undefined> {
    return this.store.getProjection<AgentConnectionState>(AGENT_CONNECTION_STATUS, agentId);
  }

  async listAll(): Promise<AgentConnectionState[]> {
    return this.store.listProjections<AgentConnectionState>(AGENT_CONNECTION_STATUS);
  }
}
