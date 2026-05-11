/**
 * OrganizationRepository — thin wrapper over CoordinatorStorePort for
 * Organization aggregate and read-model persistence.
 *
 * Uses the generic `saveProjection` / `getProjection` / `listProjections`
 * interface; the "kind" strings are stable identifiers in the projection
 * table (do not rename them after going to production without a migration).
 */

import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import type { Organization, OrganizationOverview, FeedItem } from "./types.js";

const KIND_AGGREGATE = "organization_v2";
const KIND_OVERVIEW = "organization_overview_v2";
const KIND_FEED = "organization_feed_v2";

export class OrganizationRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  // ─── Aggregate ──────────────────────────────────────────────────────────

  async save(org: Organization): Promise<void> {
    await this.store.saveProjection(KIND_AGGREGATE, org.id, org);
  }

  async get(id: string): Promise<Organization | undefined> {
    return this.store.getProjection<Organization>(KIND_AGGREGATE, id);
  }

  async list(): Promise<Organization[]> {
    return this.store.listProjections<Organization>(KIND_AGGREGATE);
  }

  // ─── Overview (list read-model) ─────────────────────────────────────────

  async saveOverview(overview: OrganizationOverview): Promise<void> {
    await this.store.saveProjection(KIND_OVERVIEW, overview.id, overview);
  }

  async getOverview(id: string): Promise<OrganizationOverview | undefined> {
    return this.store.getProjection<OrganizationOverview>(KIND_OVERVIEW, id);
  }

  async listOverviews(): Promise<OrganizationOverview[]> {
    return this.store.listProjections<OrganizationOverview>(KIND_OVERVIEW);
  }

  // ─── Feed ───────────────────────────────────────────────────────────────

  async appendFeedItem(item: FeedItem): Promise<void> {
    await this.store.saveProjection(KIND_FEED, item.feedEventId, item);
  }

  async listFeed(organizationId: string, limit = 50): Promise<FeedItem[]> {
    const all = await this.store.listProjections<FeedItem>(KIND_FEED);
    return all
      .filter((f) => f.organizationId === organizationId)
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  async listGlobalFeed(limit = 50): Promise<FeedItem[]> {
    const all = await this.store.listProjections<FeedItem>(KIND_FEED);
    return all
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
      .slice(0, limit);
  }
}
