/**
 * Public Library Repository — encapsulates CoordinatorStorePort access for
 * all four public-facing library read-model kinds.
 */

import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import type {
  ArtifactListFilter,
  PublicAgent,
  PublicArtifact,
  PublicOrganization,
  PublicProject,
} from "./types.js";

export const KIND_ARTIFACT = "public_library_artifact_v1";
export const KIND_ORG = "public_library_org_v1";
export const KIND_PROJECT = "public_library_project_v1";
export const KIND_AGENT = "public_library_agent_v1";

export class PublicLibraryRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  // ─── Artifact ─────────────────────────────────────────────────────────────

  async saveArtifact(a: PublicArtifact): Promise<void> {
    await this.store.saveProjection(KIND_ARTIFACT, a.id, a);
  }

  async getArtifactById(id: string): Promise<PublicArtifact | undefined> {
    return this.store.getProjection<PublicArtifact>(KIND_ARTIFACT, id);
  }

  async getArtifactBySlug(slug: string): Promise<PublicArtifact | undefined> {
    const all = await this.store.listProjections<PublicArtifact>(KIND_ARTIFACT);
    return all.find((a) => a.slug === slug);
  }

  async listArtifacts(filter: ArtifactListFilter = {}): Promise<PublicArtifact[]> {
    let all = await this.store.listProjections<PublicArtifact>(KIND_ARTIFACT);

    if (filter.type) all = all.filter((a) => a.type === filter.type);
    if (filter.status) all = all.filter((a) => a.status === filter.status);
    if (filter.org) all = all.filter((a) => a.orgSlug === filter.org);
    if (filter.project) all = all.filter((a) => a.projectSlug === filter.project);
    if (filter.agent) {
      all = all.filter(
        (a) =>
          a.authorAgentId === filter.agent ||
          a.contributors.some((c) => c.id === filter.agent),
      );
    }
    if (filter.locale) {
      all = all.filter((a) => !a.locale || a.locale === filter.locale);
    }
    if (filter.q) {
      const q = filter.q.toLowerCase();
      all = all.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          a.summary.toLowerCase().includes(q) ||
          a.orgName.toLowerCase().includes(q) ||
          (a.projectName ?? "").toLowerCase().includes(q) ||
          (a.authorAgentName ?? "").toLowerCase().includes(q) ||
          a.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    return all;
  }

  async listPopularArtifacts(limit = 10): Promise<PublicArtifact[]> {
    const all = await this.store.listProjections<PublicArtifact>(KIND_ARTIFACT);
    return [...all].sort((a, b) => b.hotScore - a.hotScore).slice(0, limit);
  }

  // ─── Organization ─────────────────────────────────────────────────────────

  async saveOrganization(o: PublicOrganization): Promise<void> {
    await this.store.saveProjection(KIND_ORG, o.id, o);
  }

  async getOrganizationBySlug(slug: string): Promise<PublicOrganization | undefined> {
    const all = await this.store.listProjections<PublicOrganization>(KIND_ORG);
    return all.find((o) => o.slug === slug);
  }

  async listOrganizations(): Promise<PublicOrganization[]> {
    return this.store.listProjections<PublicOrganization>(KIND_ORG);
  }

  // ─── Project ──────────────────────────────────────────────────────────────

  async saveProject(p: PublicProject): Promise<void> {
    await this.store.saveProjection(KIND_PROJECT, p.id, p);
  }

  async listProjects(q?: string): Promise<PublicProject[]> {
    let all = await this.store.listProjections<PublicProject>(KIND_PROJECT);
    if (q) {
      const lq = q.toLowerCase();
      all = all.filter(
        (p) =>
          p.name.toLowerCase().includes(lq) ||
          p.description.toLowerCase().includes(lq) ||
          p.orgName.toLowerCase().includes(lq),
      );
    }
    return all;
  }

  // ─── Agent ────────────────────────────────────────────────────────────────

  async saveAgent(a: PublicAgent): Promise<void> {
    await this.store.saveProjection(KIND_AGENT, a.id, a);
  }

  async getAgentById(id: string): Promise<PublicAgent | undefined> {
    return this.store.getProjection<PublicAgent>(KIND_AGENT, id);
  }

  async listAgents(q?: string): Promise<PublicAgent[]> {
    let all = await this.store.listProjections<PublicAgent>(KIND_AGENT);
    if (q) {
      const lq = q.toLowerCase();
      all = all.filter(
        (a) =>
          a.name.toLowerCase().includes(lq) ||
          (a.description ?? "").toLowerCase().includes(lq) ||
          (a.orgName ?? "").toLowerCase().includes(lq),
      );
    }
    return all;
  }
}
