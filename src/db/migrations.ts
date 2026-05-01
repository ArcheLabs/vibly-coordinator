import type { DatabaseSync } from "node:sqlite";

export function runMigrations(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");

  // NOTE: Do not create a generic `events` table here — it collides with
  // @concord/state when Concord uses the same SQLite file. Coordinator audit
  // events (if needed) belong in Postgres `coordinator_*` tables via Drizzle.

  db.exec(`
    CREATE TABLE IF NOT EXISTS projections (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      version TEXT,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
    CREATE INDEX IF NOT EXISTS idx_projections_kind ON projections(kind);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS leases (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      holder_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      renewed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_leases_resource ON leases(kind, resource_id);
    CREATE INDEX IF NOT EXISTS idx_leases_expires_at ON leases(expires_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      token_hash TEXT PRIMARY KEY,
      label TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_commits (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      version TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL,
      decision_record_id TEXT,
      committed_by TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      content_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_commits_project ON knowledge_commits(project_id);
  `);
}
