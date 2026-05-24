/**
 * Organization join/exit eligibility service.
 *
 * These checks are read-only — they produce a structured decision that callers
 * (API routes, Console, action intent handlers) can present to the user or act
 * on programmatically.  No state is mutated here.
 */

import { OrganizationRepository } from "../organization/repository.js";
import { IdentityRepository } from "../identity/repository.js";
import { StakeRepository } from "../stake/repository.js";
import { listBlockingObligations } from "../../application/organizationApplicationService.js";
import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EligibilityCheckStatus = "ok" | "warn" | "blocked";

export interface EligibilityCheck {
  name: string;
  status: EligibilityCheckStatus;
  message: string;
  /** Structured details for programmatic handling (e.g. stake amounts). */
  details?: Record<string, unknown>;
}

export interface EligibilityResult {
  eligible: boolean;
  checks: EligibilityCheck[];
  /** Present when a specific action is needed before eligibility can be met. */
  requiredAction?: {
    type: "stake" | "register-agent" | "setup-identity";
    required?: string;
    current?: string;
    message: string;
  };
}

export interface JoinEligibilityInput {
  organizationId: string;
  principalId: string;
  /** Needed for stake lookup. */
  chainId?: string;
  identityId?: string;
  chainAgentId?: string;
  /** Override the global min stake (bigint string). Default "0". */
  minActiveStake?: string;
}

export interface ExitEligibilityInput {
  organizationId: string;
  principalId: string;
}

// ─── Join eligibility ─────────────────────────────────────────────────────────

export async function checkJoinEligibility(
  input: JoinEligibilityInput,
  store: CoordinatorStorePort,
): Promise<EligibilityResult> {
  const checks: EligibilityCheck[] = [];
  const orgRepo = new OrganizationRepository(store);
  const identityRepo = new IdentityRepository(store);
  const stakeRepo = new StakeRepository(store);

  // ── 1. Organization exists and is active ──────────────────────────────────
  const org = await orgRepo.get(input.organizationId);
  if (!org) {
    checks.push({ name: "organization-active", status: "blocked", message: "Organization not found" });
    return { eligible: false, checks };
  }
  if (org.status !== "active") {
    checks.push({ name: "organization-active", status: "blocked", message: `Organization is ${org.status}` });
    return { eligible: false, checks };
  }
  checks.push({ name: "organization-active", status: "ok", message: "Organization is active" });

  // ── 2. Not already a member ───────────────────────────────────────────────
  const alreadyMember = org.members.some((m) => m.principalId === input.principalId);
  if (alreadyMember) {
    checks.push({ name: "not-already-member", status: "blocked", message: "Agent is already a member of this organization" });
    return { eligible: false, checks };
  }
  checks.push({ name: "not-already-member", status: "ok", message: "Agent is not yet a member" });

  // ── 3. Agent profile registered ───────────────────────────────────────────
  const profile = await identityRepo.getAgentProfile(input.principalId);
  if (!profile) {
    checks.push({ name: "agent-registered", status: "blocked", message: "Agent profile not found in coordinator" });
    return {
      eligible: false,
      checks,
      requiredAction: { type: "register-agent", message: "Agent must be registered with the coordinator before joining" },
    };
  }
  if (profile.dutyStatus === "paused") {
    checks.push({ name: "agent-duty-active", status: "blocked", message: "Agent duty is paused" });
    return { eligible: false, checks };
  }
  checks.push({ name: "agent-registered", status: "ok", message: "Agent profile found" });

  // ── 4. Stake requirement ──────────────────────────────────────────────────
  const minStake = BigInt(input.minActiveStake ?? "0");
  if (minStake > 0n) {
    const ledger = await stakeRepo.getLedgerForProfile({
      chainId: input.chainId,
      identityId: input.identityId,
      chainAgentId: input.chainAgentId,
    });

    if (!ledger) {
      checks.push({
        name: "stake-active",
        status: "blocked",
        message: "No stake ledger found. Stake is required to join this organization.",
        details: { required: input.minActiveStake, current: "0" },
      });
      return {
        eligible: false,
        checks,
        requiredAction: {
          type: "stake",
          required: input.minActiveStake,
          current: "0",
          message: "Bond stake before joining this organization",
        },
      };
    }

    if (ledger.status !== "active") {
      checks.push({
        name: "stake-active",
        status: "blocked",
        message: `Stake status is "${ledger.status}". Active stake is required.`,
        details: { required: input.minActiveStake, current: ledger.activeAmount, status: ledger.status },
      });
      return {
        eligible: false,
        checks,
        requiredAction: {
          type: "stake",
          required: input.minActiveStake,
          current: ledger.activeAmount,
          message: "Activate stake before joining this organization",
        },
      };
    }

    const active = BigInt(ledger.activeAmount);
    if (active < minStake) {
      checks.push({
        name: "stake-sufficient",
        status: "blocked",
        message: "Active stake is below the organization minimum.",
        details: { required: input.minActiveStake, current: ledger.activeAmount },
      });
      return {
        eligible: false,
        checks,
        requiredAction: {
          type: "stake",
          required: input.minActiveStake,
          current: ledger.activeAmount,
          message: "Bond more stake to meet the organization minimum",
        },
      };
    }

    checks.push({ name: "stake-sufficient", status: "ok", message: "Stake requirement met", details: { active: ledger.activeAmount } });
  } else {
    checks.push({ name: "stake-sufficient", status: "ok", message: "No stake requirement" });
  }

  return { eligible: true, checks };
}

// ─── Exit eligibility ─────────────────────────────────────────────────────────

export async function checkExitEligibility(
  input: ExitEligibilityInput,
  store: CoordinatorStorePort,
): Promise<EligibilityResult> {
  const checks: EligibilityCheck[] = [];
  const orgRepo = new OrganizationRepository(store);

  // ── 1. Organization exists ────────────────────────────────────────────────
  const org = await orgRepo.get(input.organizationId);
  if (!org) {
    checks.push({ name: "organization-exists", status: "blocked", message: "Organization not found" });
    return { eligible: false, checks };
  }
  if (org.status === "dissolved") {
    checks.push({ name: "organization-not-dissolved", status: "blocked", message: "Organization is dissolved" });
    return { eligible: false, checks };
  }
  checks.push({ name: "organization-exists", status: "ok", message: "Organization found" });

  // ── 2. Currently a member ─────────────────────────────────────────────────
  const isMember = org.members.some((m) => m.principalId === input.principalId);
  if (!isMember) {
    checks.push({ name: "is-member", status: "blocked", message: "Agent is not a member of this organization" });
    return { eligible: false, checks };
  }
  checks.push({ name: "is-member", status: "ok", message: "Agent is a member" });

  // ── 3. No blocking obligations ────────────────────────────────────────────
  const blockers = await listBlockingObligations(store, input.principalId);
  if (blockers.length > 0) {
    checks.push({
      name: "no-active-obligations",
      status: "blocked",
      message: "Agent has unfinished public obligations that block exit",
      details: { blockers },
    });
    return { eligible: false, checks };
  }
  checks.push({ name: "no-active-obligations", status: "ok", message: "No blocking obligations" });

  return { eligible: true, checks };
}
