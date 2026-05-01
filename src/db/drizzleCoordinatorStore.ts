import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { v4 as uuidv4 } from "uuid";
import type { CoordinatorStorePort, CreateLeaseInput, Lease } from "./coordinatorStorePort.js";
import * as schema from "./postgres/schema.js";

export class DrizzleCoordinatorStore implements CoordinatorStorePort {
  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

  async createLease(input: CreateLeaseInput): Promise<Lease> {
    const id = `lease_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
    await this.db.insert(schema.coordinatorLeases).values({
      id,
      kind: input.kind,
      resourceId: input.resourceId,
      holderId: input.holderId,
      expiresAt,
      createdAt: now,
    });
    return { id, kind: input.kind, resourceId: input.resourceId, holderId: input.holderId, expiresAt, createdAt: now };
  }

  async getLease(id: string): Promise<Lease | undefined> {
    const rows = await this.db
      .select()
      .from(schema.coordinatorLeases)
      .where(eq(schema.coordinatorLeases.id, id))
      .limit(1);
    const row = rows[0];
    return row ? this.rowToLease(row) : undefined;
  }

  async getActiveLease(kind: string, resourceId: string): Promise<Lease | undefined> {
    const nowIso = new Date().toISOString();
    const rows = await this.db
      .select()
      .from(schema.coordinatorLeases)
      .where(
        and(
          eq(schema.coordinatorLeases.kind, kind),
          eq(schema.coordinatorLeases.resourceId, resourceId),
          gt(schema.coordinatorLeases.expiresAt, nowIso),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? this.rowToLease(row) : undefined;
  }

  async renewLease(id: string, ttlMs: number): Promise<Lease | undefined> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const rows = await this.db
      .update(schema.coordinatorLeases)
      .set({ expiresAt, renewedAt: now })
      .where(eq(schema.coordinatorLeases.id, id))
      .returning();
    const row = rows[0];
    return row ? this.rowToLease(row) : undefined;
  }

  async releaseLease(id: string): Promise<void> {
    await this.db.delete(schema.coordinatorLeases).where(eq(schema.coordinatorLeases.id, id));
  }

  async sweepExpiredLeases(now: Date = new Date()): Promise<Lease[]> {
    const nowIso = now.toISOString();
    const expired = await this.db.select().from(schema.coordinatorLeases).where(lte(schema.coordinatorLeases.expiresAt, nowIso));
    if (expired.length > 0) {
      await this.db.delete(schema.coordinatorLeases).where(lte(schema.coordinatorLeases.expiresAt, nowIso));
    }
    return expired.map((r) => this.rowToLease(r));
  }

  async saveProjection(kind: string, id: string, data: unknown, version?: string): Promise<void> {
    const now = new Date().toISOString();
    const row = {
      kind,
      id,
      version: version ?? null,
      dataJson: JSON.stringify(data),
      updatedAt: now,
    };
    await this.db
      .insert(schema.coordinatorProjections)
      .values(row)
      .onConflictDoUpdate({
        target: [schema.coordinatorProjections.kind, schema.coordinatorProjections.id],
        set: {
          version: sql`excluded.version`,
          dataJson: sql`excluded.data_json`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  async getProjection<T = unknown>(kind: string, id: string): Promise<T | undefined> {
    const rows = await this.db
      .select()
      .from(schema.coordinatorProjections)
      .where(and(eq(schema.coordinatorProjections.kind, kind), eq(schema.coordinatorProjections.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return JSON.parse(row.dataJson) as T;
  }

  async listProjections<T = unknown>(kind: string): Promise<T[]> {
    const rows = await this.db.select().from(schema.coordinatorProjections).where(eq(schema.coordinatorProjections.kind, kind));
    return rows.map((r) => JSON.parse(r.dataJson) as T);
  }

  async deleteProjection(kind: string, id: string): Promise<void> {
    await this.db
      .delete(schema.coordinatorProjections)
      .where(and(eq(schema.coordinatorProjections.kind, kind), eq(schema.coordinatorProjections.id, id)));
  }

  private rowToLease(row: typeof schema.coordinatorLeases.$inferSelect): Lease {
    return {
      id: row.id,
      kind: row.kind,
      resourceId: row.resourceId,
      holderId: row.holderId,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      renewedAt: row.renewedAt ?? undefined,
    };
  }
}
