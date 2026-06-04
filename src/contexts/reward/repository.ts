import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import type {
  AgentRewardIndexerHealth,
  AgentRewardLedger,
  RewardDayState,
  RoundRewardSettlement,
  TaskRewardApproval,
  TaskRewardSettlement,
  TaskRewardSuggestion,
} from "./types.js";

export const AGENT_REWARD_LEDGER_KIND = "agent_reward_ledger_v1";
export const REWARD_DAY_STATE_KIND = "reward_day_state_v1";
export const ROUND_REWARD_SETTLEMENT_KIND = "round_reward_settlement_v1";
export const TASK_REWARD_SETTLEMENT_KIND = "task_reward_settlement_v1";
export const TASK_REWARD_SUGGESTION_KIND = "task_reward_suggestion_v1";
export const TASK_REWARD_APPROVAL_KIND = "task_reward_approval_v1";
export const AGENT_REWARD_INDEXER_HEALTH_KIND = "agent_reward_indexer_health_v1";
export const AGENT_REWARD_INDEXER_HEALTH_ID = "agent-reward-indexer";

export class RewardRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async saveLedger(ledger: AgentRewardLedger): Promise<void> {
    await this.store.saveProjection(AGENT_REWARD_LEDGER_KIND, ledger.id, ledger);
  }

  async getLedger(id: string): Promise<AgentRewardLedger | undefined> {
    return this.store.getProjection<AgentRewardLedger>(AGENT_REWARD_LEDGER_KIND, id);
  }

  async listLedgers(): Promise<AgentRewardLedger[]> {
    return this.store.listProjections<AgentRewardLedger>(AGENT_REWARD_LEDGER_KIND);
  }

  async saveRewardDay(day: RewardDayState): Promise<void> {
    await this.store.saveProjection(REWARD_DAY_STATE_KIND, day.id, day);
  }

  async listRewardDays(): Promise<RewardDayState[]> {
    return this.store.listProjections<RewardDayState>(REWARD_DAY_STATE_KIND);
  }

  async saveRoundSettlement(settlement: RoundRewardSettlement): Promise<void> {
    await this.store.saveProjection(ROUND_REWARD_SETTLEMENT_KIND, settlement.id, settlement);
  }

  async getRoundSettlement(id: string): Promise<RoundRewardSettlement | undefined> {
    return this.store.getProjection<RoundRewardSettlement>(ROUND_REWARD_SETTLEMENT_KIND, id);
  }

  async listRoundSettlements(): Promise<RoundRewardSettlement[]> {
    return this.store.listProjections<RoundRewardSettlement>(ROUND_REWARD_SETTLEMENT_KIND);
  }

  async saveTaskRewardSettlement(settlement: TaskRewardSettlement): Promise<void> {
    await this.store.saveProjection(TASK_REWARD_SETTLEMENT_KIND, settlement.id, settlement);
  }

  async getTaskRewardSettlement(taskId: string): Promise<TaskRewardSettlement | undefined> {
    return this.store.getProjection<TaskRewardSettlement>(TASK_REWARD_SETTLEMENT_KIND, taskId);
  }

  async listTaskRewardSettlements(): Promise<TaskRewardSettlement[]> {
    return this.store.listProjections<TaskRewardSettlement>(TASK_REWARD_SETTLEMENT_KIND);
  }

  async saveTaskRewardSuggestion(suggestion: TaskRewardSuggestion): Promise<void> {
    await this.store.saveProjection(TASK_REWARD_SUGGESTION_KIND, suggestion.id, suggestion);
  }

  async getTaskRewardSuggestion(id: string): Promise<TaskRewardSuggestion | undefined> {
    return this.store.getProjection<TaskRewardSuggestion>(TASK_REWARD_SUGGESTION_KIND, id);
  }

  async listTaskRewardSuggestions(taskId?: string): Promise<TaskRewardSuggestion[]> {
    const items = await this.store.listProjections<TaskRewardSuggestion>(TASK_REWARD_SUGGESTION_KIND);
    return taskId ? items.filter((item) => item.taskId === taskId) : items;
  }

  async saveTaskRewardApproval(approval: TaskRewardApproval): Promise<void> {
    await this.store.saveProjection(TASK_REWARD_APPROVAL_KIND, approval.taskId, approval);
  }

  async getTaskRewardApproval(taskId: string): Promise<TaskRewardApproval | undefined> {
    return this.store.getProjection<TaskRewardApproval>(TASK_REWARD_APPROVAL_KIND, taskId);
  }

  async saveIndexerHealth(health: AgentRewardIndexerHealth): Promise<void> {
    await this.store.saveProjection(AGENT_REWARD_INDEXER_HEALTH_KIND, health.id, health);
  }

  async getIndexerHealth(): Promise<AgentRewardIndexerHealth | undefined> {
    return this.store.getProjection<AgentRewardIndexerHealth>(AGENT_REWARD_INDEXER_HEALTH_KIND, AGENT_REWARD_INDEXER_HEALTH_ID);
  }
}
