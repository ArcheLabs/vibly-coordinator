/**
 * selectReviewersForCycle — global-pool reviewer selection with audit.
 *
 * Picks reviewers for a ReviewCycle from the global Agent pool, applying
 * eligibility filtering, submitter/proposer exclusion, mechanism policy,
 * and the system hard-cap (globalMaxReviewersPerCycle).
 */

import { makeId } from "@concord/foundation";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import type { CoordinatorConfig } from "../config/env.js";
import type { SelectionRule } from "../contexts/mechanism/types.js";
import { IdentityRepository } from "../contexts/identity/repository.js";
import { SelectionAuditRepository } from "../contexts/selection/repository.js";
import type { SelectionAudit } from "../contexts/selection/types.js";
import { filterEligibleAgents } from "./agentEligibility.js";
import { selectParticipants } from "../contexts/mechanism/mechanismEngine.js";

export interface SelectReviewersOptions {
  store: CoordinatorStorePort;
  config: CoordinatorConfig;
  reviewRoundId: string;
  reviewCycleId: string;
  cycleIndex: number;
  submitterId?: string;
  proposerId?: string;
  organizationId: string;
  rule?: Pick<SelectionRule, "minReputation" | "minStake" | "count" | "primitive">;
}

export interface SelectReviewersResult {
  selectedIds: string[];
  auditId: string;
}

export async function selectReviewersForCycle(
  opts: SelectReviewersOptions,
): Promise<SelectReviewersResult> {
  const {
    store,
    config,
    reviewRoundId,
    reviewCycleId,
    cycleIndex,
    submitterId,
    proposerId,
    organizationId,
    rule,
  } = opts;

  const identityRepo = new IdentityRepository(store);
  const auditRepo = new SelectionAuditRepository(store);

  const allAgents = await identityRepo.listAgentProfiles();
  const eligible = await filterEligibleAgents(store, allAgents, rule);

  const candidateIds = eligible.map((a) => a.principalId);
  const excludeReasons: Record<string, string> = {};
  const excludedIds: string[] = [];

  const filtered = eligible.filter((a) => {
    if (submitterId && a.principalId === submitterId) {
      excludeReasons[a.principalId] = "submitter";
      excludedIds.push(a.principalId);
      return false;
    }
    if (proposerId && a.principalId === proposerId) {
      excludeReasons[a.principalId] = "proposer";
      excludedIds.push(a.principalId);
      return false;
    }
    return true;
  });

  const desiredCount = rule?.count ?? 3;
  const actualCount = Math.min(desiredCount, config.globalMaxReviewersPerCycle, filtered.length);

  const selectionRule: SelectionRule = {
    primitive: rule?.primitive ?? "random-selection",
    count: actualCount,
    ...(rule?.minReputation != null && { minReputation: rule.minReputation }),
    ...(rule?.minStake != null && { minStake: rule.minStake }),
  };

  const candidates = filtered.map((a) => a.principalId);
  const { selected: selectedIds } = selectParticipants(selectionRule, { candidates });

  const now = new Date().toISOString();
  const auditId = makeId("sel");
  const audit: SelectionAudit = {
    id: auditId,
    reviewCycleId,
    roundId: reviewRoundId,
    organizationId,
    scope: "review",
    candidateIds,
    excludedIds,
    selectedIds,
    excludeReasons,
    rule: { ...selectionRule, cycleIndex },
    createdAt: now,
  };
  await auditRepo.save(audit);

  return { selectedIds, auditId };
}
