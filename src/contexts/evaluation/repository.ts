import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import type { ReviewRound } from "./types.js";

const KIND = "review_round_v2";

export class ReviewRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async save(r: ReviewRound): Promise<void> {
    await this.store.saveProjection(KIND, r.id, r);
  }

  async get(id: string): Promise<ReviewRound | undefined> {
    return this.store.getProjection<ReviewRound>(KIND, id);
  }

  async list(organizationId?: string): Promise<ReviewRound[]> {
    const all = await this.store.listProjections<ReviewRound>(KIND);
    return organizationId ? all.filter((r) => r.organizationId === organizationId) : all;
  }
}
