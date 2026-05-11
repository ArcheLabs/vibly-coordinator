import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import type { Artifact } from "./types.js";

const KIND = "artifact_v2";

export class ArtifactRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async save(a: Artifact): Promise<void> {
    await this.store.saveProjection(KIND, a.id, a);
  }

  async get(id: string): Promise<Artifact | undefined> {
    return this.store.getProjection<Artifact>(KIND, id);
  }

  async list(organizationId?: string): Promise<Artifact[]> {
    const all = await this.store.listProjections<Artifact>(KIND);
    return organizationId ? all.filter((a) => a.organizationId === organizationId) : all;
  }
}
