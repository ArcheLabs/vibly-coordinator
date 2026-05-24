/**
 * Organization context — core domain types.
 *
 * Organization is the top-level long-lived entity in Vibly v0.2.
 * Projects are execution units *within* an Organization.
 */

export interface OrganizationHandbook {
  mission: string;
  vision?: string;
  values?: string[];
  principles?: string[];
  /** Stake / reputation / reward baseline rules. */
  economicPolicy?: Record<string, unknown>;
  /** Human intervention rules. */
  guardianPolicy?: Record<string, unknown>;
  updatedAt: string;
  schemaVersion: "1";
}

export interface OrganizationMember {
  principalId: string;
  role: string;
  joinedAt: string;
  /** Identity root owner id if known at join time. */
  identityId?: string;
  /** On-chain agent id (SS58 account). */
  chainAgentId?: string;
  /** Chain id the agent belongs to. */
  chainId?: string;
  /** Principal id of the actor who performed the join operation. */
  joinedBy?: string;
  /** How the member was added. */
  joinMode?: "root-owner" | "guardian-forced" | "admin-forced";
}

export interface AuthorityAssignment {
  principalId: string;
  authority: string;
  grantedAt: string;
  grantedBy: string;
}

export type OrganizationStatus = "active" | "paused" | "dissolved";

export interface Organization {
  id: string;
  name: string;
  description?: string;
  status: OrganizationStatus;
  handbook?: OrganizationHandbook;
  members: OrganizationMember[];
  authorities: AuthorityAssignment[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Principal id of the last actor to update the organization profile. */
  updatedBy?: string;
  /** ISO timestamp set when the organization is dissolved. */
  dissolvedAt?: string;
  /** Principal id of the actor who dissolved the organization. */
  dissolvedBy?: string;
}

/** Lightweight overview for list responses. */
export interface OrganizationOverview {
  id: string;
  name: string;
  description?: string;
  status: OrganizationStatus;
  memberCount: number;
  feedCount?: number;
  artifactCount?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Feed item — a single entry in an Organization's activity feed.
 * Represents any v0.2 domain event that is surfaced to the Console.
 */
export interface FeedItem {
  feedEventId: string;
  eventType: string;
  organizationId: string;
  projectId?: string;
  actorId?: string;
  subject?: { kind: string; id: string };
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
