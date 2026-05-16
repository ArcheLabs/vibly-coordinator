import type { DatabaseSync } from "node:sqlite";
import { v4 as uuidv4 } from "uuid";
import type { CoordinatorStorePort, CreateLeaseInput, Lease } from "./coordinatorStorePort.js";

export type { CoordinatorStorePort, CreateLeaseInput, Lease } from "./coordinatorStorePort.js";

/** SQLite-backed store for local development and tests. */
export class SqliteCoordinatorStore implements CoordinatorStorePort {
  constructor(private readonly db: DatabaseSync) {}

  async createLease(input: CreateLeaseInput): Promise<Lease> {
    const id = `lease_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();

    this.db.prepare(
      `INSERT INTO leases (id, kind, resource_id, holder_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.kind, input.resourceId, input.holderId, expiresAt, now);

    return { id, kind: input.kind, resourceId: input.resourceId, holderId: input.holderId, expiresAt, createdAt: now };
  }

  async tryAcquireLease(input: CreateLeaseInput): Promise<Lease | undefined> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
    this.db.prepare(`DELETE FROM leases WHERE kind = ? AND resource_id = ? AND expires_at <= ?`).run(input.kind, input.resourceId, now);
    const active = await this.getActiveLease(input.kind, input.resourceId);
    if (active) return undefined;

    const id = `lease_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
    this.db.prepare(
      `INSERT INTO leases (id, kind, resource_id, holder_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.kind, input.resourceId, input.holderId, expiresAt, now);
    return { id, kind: input.kind, resourceId: input.resourceId, holderId: input.holderId, expiresAt, createdAt: now };
  }

  async getLease(id: string): Promise<Lease | undefined> {
    const row = this.db.prepare(`SELECT * FROM leases WHERE id = ?`).get(id) as
      | { id: string; kind: string; resource_id: string; holder_id: string; expires_at: string; created_at: string; renewed_at?: string }
      | undefined;
    if (!row) return undefined;
    return this.rowToLease(row);
  }

  async getActiveLease(kind: string, resourceId: string): Promise<Lease | undefined> {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(`SELECT * FROM leases WHERE kind = ? AND resource_id = ? AND expires_at > ? LIMIT 1`)
      .get(kind, resourceId, now) as
      | { id: string; kind: string; resource_id: string; holder_id: string; expires_at: string; created_at: string; renewed_at?: string }
      | undefined;
    if (!row) return undefined;
    return this.rowToLease(row);
  }

  async renewLease(id: string, ttlMs: number): Promise<Lease | undefined> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const result = this.db
      .prepare(`UPDATE leases SET expires_at = ?, renewed_at = ? WHERE id = ? RETURNING *`)
      .get(expiresAt, now, id) as
      | { id: string; kind: string; resource_id: string; holder_id: string; expires_at: string; created_at: string; renewed_at?: string }
      | undefined;
    if (!result) return undefined;
    return this.rowToLease(result);
  }

  async releaseLease(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM leases WHERE id = ?`).run(id);
  }

  async sweepExpiredLeases(now: Date = new Date()): Promise<Lease[]> {
    const nowIso = now.toISOString();
    const expired = this.db
      .prepare(`SELECT * FROM leases WHERE expires_at <= ?`)
      .all(nowIso) as { id: string; kind: string; resource_id: string; holder_id: string; expires_at: string; created_at: string; renewed_at?: string }[];
    if (expired.length > 0) {
      this.db.prepare(`DELETE FROM leases WHERE expires_at <= ?`).run(nowIso);
    }
    return expired.map((r) => this.rowToLease(r));
  }

  async saveProjection(kind: string, id: string, data: unknown, version?: string): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO projections (kind, id, version, data_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, id) DO UPDATE SET version = excluded.version, data_json = excluded.data_json, updated_at = excluded.updated_at`,
      )
      .run(kind, id, version ?? null, JSON.stringify(data), now);
  }

  async getProjection<T = unknown>(kind: string, id: string): Promise<T | undefined> {
    const row = this.db.prepare(`SELECT data_json FROM projections WHERE kind = ? AND id = ?`).get(kind, id) as
      | { data_json: string }
      | undefined;
    if (!row) return undefined;
    return JSON.parse(row.data_json) as T;
  }

  async listProjections<T = unknown>(kind: string): Promise<T[]> {
    const rows = this.db.prepare(`SELECT data_json FROM projections WHERE kind = ?`).all(kind) as { data_json: string }[];
    return rows.map((r) => JSON.parse(r.data_json) as T);
  }

  async deleteProjection(kind: string, id: string): Promise<void> {
    this.db.prepare(`DELETE FROM projections WHERE kind = ? AND id = ?`).run(kind, id);
  }

  private rowToLease(row: {
    id: string;
    kind: string;
    resource_id: string;
    holder_id: string;
    expires_at: string;
    created_at: string;
    renewed_at?: string;
  }): Lease {
    return {
      id: row.id,
      kind: row.kind,
      resourceId: row.resource_id,
      holderId: row.holder_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      renewedAt: row.renewed_at,
    };
  }
}

/** @deprecated Prefer {@link SqliteCoordinatorStore} or {@link CoordinatorStorePort}. */
export type CoordinatorStore = CoordinatorStorePort;
