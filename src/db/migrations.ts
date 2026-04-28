import type { DatabaseSync } from "node:sqlite";

export function runMigrations(db: DatabaseSync): void {
  // Enable WAL mode for better concurrency
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");

  // Events table — audit source of truth
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      version TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      actor_id TEXT,
      causation_id TEXT,
      correlation_id TEXT,
      payload_json TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      hash_json TEXT,
      signature_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_id);
    CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id);
    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
  `);

  // Projections table — read model, rebuildable from events
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

  // Leases table — coordinator operational state
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

  // API tokens table — static tokens for P1
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      token_hash TEXT PRIMARY KEY,
      label TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
  `);

  // Knowledge commits table — coordinator-side tracking
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
