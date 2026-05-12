import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import type { AgentStakeLedger } from "./types.js";

export const AGENT_STAKE_LEDGER_KIND = "agent_stake_ledger_v1";

export class StakeRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async saveLedger(ledger: AgentStakeLedger): Promise<void> {
    await this.store.saveProjection(AGENT_STAKE_LEDGER_KIND, ledger.id, ledger);
  }

  async getLedger(id: string): Promise<AgentStakeLedger | undefined> {
    return this.store.getProjection<AgentStakeLedger>(AGENT_STAKE_LEDGER_KIND, id);
  }

  async getLedgerForProfile(input: { chainId?: string; identityId?: string; chainAgentId?: string }): Promise<AgentStakeLedger | undefined> {
    if (!input.chainId || !input.identityId || !input.chainAgentId) return undefined;
    return this.getLedger(`${input.chainId}:${input.identityId}:${input.chainAgentId}`);
  }

  async listLedgers(): Promise<AgentStakeLedger[]> {
    return this.store.listProjections<AgentStakeLedger>(AGENT_STAKE_LEDGER_KIND);
  }
}
