import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import { REVIEW_CYCLE } from "../../db/projectionKinds.js";
import type { ReviewRound, ReviewCycle } from "./types.js";

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

export class ReviewCycleRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async save(cycle: ReviewCycle): Promise<void> {
    await this.store.saveProjection(REVIEW_CYCLE, cycle.id, cycle);
  }

  async get(id: string): Promise<ReviewCycle | undefined> {
    return this.store.getProjection<ReviewCycle>(REVIEW_CYCLE, id);
  }

  async listForRound(reviewRoundId: string): Promise<ReviewCycle[]> {
    const all = await this.store.listProjections<ReviewCycle>(REVIEW_CYCLE);
    return all
      .filter((c) => c.reviewRoundId === reviewRoundId)
      .sort((a, b) => a.cycleIndex - b.cycleIndex);
  }

  async findActiveCycle(reviewRoundId: string): Promise<ReviewCycle | undefined> {
    const all = await this.listForRound(reviewRoundId);
    return all.find((c) => c.status === "active");
  }
}
