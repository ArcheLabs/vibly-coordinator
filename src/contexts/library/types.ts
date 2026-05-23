/**
 * Public Library read-model types.
 *
 * These are public-facing projections built from internal workflow artifacts
 * (artifact_v2, knowledge_entry_v2) and are distinct from the internal
 * Artifact / Organization domain types.
 */

// ─── Enumerations ─────────────────────────────────────────────────────────────

export type PublicArtifactStatus = "published" | "verified" | "updated";
export type PublicArtifactType = "report" | "spec" | "note" | "template";

// ─── Core models ──────────────────────────────────────────────────────────────

export interface PublicArtifactContributor {
  id: string;
  name: string;
  role?: string;
}

export interface PublicArtifact {
  id: string;
  title: string;
  slug: string;
  summary: string;
  /** Markdown body; derived from knowledge_entry_v2.content or artifact.description */
  markdown: string;
  locale?: string;

  orgId: string;
  orgSlug: string;
  orgName: string;

  projectId?: string;
  projectSlug?: string;
  projectName?: string;

  type: PublicArtifactType;
  status: PublicArtifactStatus;
  /** Display order within a project. 0 = unordered. */
  order: number;
  tags: string[];

  authorAgentId?: string;
  authorAgentName?: string;
  contributors: PublicArtifactContributor[];

  reviewCount: number;
  hotScore: number;
  version: number;

  sourceTaskId?: string;
  sourceDiscussionId?: string;
  sourceReviewRoundIds: string[];
  sourceKnowledgeEntryId?: string;

  createdAt: string;
  updatedAt: string;
  publishedAt: string;
}

export interface PublicOrganization {
  id: string;
  slug: string;
  name: string;
  description: string;
  documentCount: number;
  agentCount: number;
  projectCount: number;
}

export interface PublicProject {
  id: string;
  slug: string;
  name: string;
  description: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  documentCount: number;
  agentCount: number;
}

export interface PublicAgent {
  id: string;
  name: string;
  role?: string;
  description?: string;
  reputation: number;
  documentCount: number;
  orgName?: string;
  orgSlug?: string;
}

// ─── Query helpers ─────────────────────────────────────────────────────────────

export interface ArtifactListFilter {
  q?: string;
  sort?: "comprehensive" | "latest" | "hot" | "reviewed" | "order";
  type?: PublicArtifactType;
  status?: PublicArtifactStatus;
  org?: string;
  project?: string;
  agent?: string;
  locale?: string;
  limit?: number;
  offset?: number;
}
