import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import type { RewardIntent, SettlementBatch } from "./types.js";

const REWARD_KIND = "reward_intent_v2";
const BATCH_KIND = "settlement_batch_v2";

export class SettlementRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async saveRewardIntent(r: RewardIntent): Promise<void> {
    await this.store.saveProjection(REWARD_KIND, r.id, r);
  }

  async getRewardIntent(id: string): Promise<RewardIntent | undefined> {
    return this.store.getProjection<RewardIntent>(REWARD_KIND, id);
  }

  async listRewardIntents(organizationId?: string, status?: RewardIntent["status"]): Promise<RewardIntent[]> {
    const all = await this.store.listProjections<RewardIntent>(REWARD_KIND);
    return all.filter((r) => {
      if (organizationId && r.organizationId !== organizationId) return false;
      if (status && r.status !== status) return false;
      return true;
    });
  }

  async saveBatch(b: SettlementBatch): Promise<void> {
    await this.store.saveProjection(BATCH_KIND, b.id, b);
  }

  async getBatch(id: string): Promise<SettlementBatch | undefined> {
    return this.store.getProjection<SettlementBatch>(BATCH_KIND, id);
  }

  async listBatches(organizationId?: string): Promise<SettlementBatch[]> {
    const all = await this.store.listProjections<SettlementBatch>(BATCH_KIND);
    return organizationId ? all.filter((b) => b.organizationId === organizationId) : all;
  }
}
