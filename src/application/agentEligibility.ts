import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import type { AgentProfile } from "../contexts/identity/types.js";
import { StakeRepository } from "../contexts/stake/repository.js";
import type { SelectionRule } from "../contexts/mechanism/types.js";
import { checkEligibility } from "../contexts/mechanism/mechanismEngine.js";

export async function filterEligibleAgents(
  store: CoordinatorStorePort,
  agents: AgentProfile[],
  rule?: Pick<SelectionRule, "minReputation" | "minStake">,
): Promise<AgentProfile[]> {
  const stakeRepo = new StakeRepository(store);
  const out: AgentProfile[] = [];
  for (const agent of agents) {
    if ((agent.dutyStatus ?? "active") !== "active") continue;
    const ledger = await stakeRepo.getLedgerForProfile(agent);
    const requiresStake = rule?.minStake != null || agent.chainAgentId != null || agent.identityId != null;
    if (requiresStake) {
      if (!ledger || ledger.status !== "active") continue;
      if (ledger.releaseBlocked) continue;
      let stakeBalance: bigint;
      try {
        stakeBalance = BigInt(ledger.activeAmount);
      } catch {
        continue;
      }
      if (!checkEligibility({
        principalId: agent.principalId,
        reputationScore: agent.reputationScore,
        stakeBalance,
        rule: rule ?? {},
      })) continue;
    } else if (!checkEligibility({
      principalId: agent.principalId,
      reputationScore: agent.reputationScore,
      rule: rule ?? {},
    })) {
      continue;
    }
    out.push(agent);
  }
  return out;
}
