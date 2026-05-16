/**
 * Identity context — domain types for principals, agents and memberships.
 *
 * Re-uses shapes from @concord/* where they already exist; adds
 * coordinator-side projections for agent profile read models.
 */

export type PrincipalKind = "agent" | "human";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  displayName?: string;
  email?: string;
  organizationIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfile {
  principalId: string;
  displayName: string;
  capabilities: string[];
  organizationIds: string[];
  reputationScore?: number;
  /** @deprecated Coordinator eligibility uses chain stake read models, not this local field. */
  stakeBalance?: string;
  chainId?: string;
  identityId?: string;
  chainAgentId?: string;
  evmAddress?: string;
  dutyStatus?: "active" | "paused";
  stakeStatus?: "active" | "unbonding" | "released" | "missing" | "stale";
  createdAt: string;
  updatedAt: string;
}
