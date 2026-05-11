import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import type { CoordinationMechanism } from "./types.js";

const KIND = "mechanism_v2";

export class MechanismRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async save(m: CoordinationMechanism): Promise<void> {
    await this.store.saveProjection(KIND, m.id, m);
  }

  async get(id: string): Promise<CoordinationMechanism | undefined> {
    return this.store.getProjection<CoordinationMechanism>(KIND, id);
  }

  async list(organizationId?: string): Promise<CoordinationMechanism[]> {
    const all = await this.store.listProjections<CoordinationMechanism>(KIND);
    return organizationId ? all.filter((m) => m.organizationId === organizationId) : all;
  }
}
