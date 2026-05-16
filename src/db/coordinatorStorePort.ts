export interface Lease {
  id: string;
  kind: string;
  resourceId: string;
  holderId: string;
  expiresAt: string;
  createdAt: string;
  renewedAt?: string;
}

export interface CreateLeaseInput {
  kind: string;
  resourceId: string;
  holderId: string;
  ttlMs: number;
}

/**
 * Coordinator-owned persistence (projections, leases, etc.).
 * Implemented by SQLite (dev/test) and Drizzle/Postgres (production).
 */
export interface CoordinatorStorePort {
  createLease(input: CreateLeaseInput): Promise<Lease>;
  tryAcquireLease(input: CreateLeaseInput): Promise<Lease | undefined>;
  getLease(id: string): Promise<Lease | undefined>;
  getActiveLease(kind: string, resourceId: string): Promise<Lease | undefined>;
  renewLease(id: string, ttlMs: number): Promise<Lease | undefined>;
  releaseLease(id: string): Promise<void>;
  sweepExpiredLeases(now?: Date): Promise<Lease[]>;

  saveProjection(kind: string, id: string, data: unknown, version?: string): Promise<void>;
  getProjection<T = unknown>(kind: string, id: string): Promise<T | undefined>;
  listProjections<T = unknown>(kind: string): Promise<T[]>;
  deleteProjection(kind: string, id: string): Promise<void>;
}
