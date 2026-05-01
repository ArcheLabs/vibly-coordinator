import {
  bigserial,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const coordinatorProjections = pgTable(
  "coordinator_projections",
  {
    kind: text("kind").notNull(),
    id: text("id").notNull(),
    version: text("version"),
    dataJson: text("data_json").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.id] })],
);

export const coordinatorLeases = pgTable("coordinator_leases", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  resourceId: text("resource_id").notNull(),
  holderId: text("holder_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  renewedAt: timestamp("renewed_at", { withTimezone: true, mode: "string" }),
});

export const coordinatorApiTokens = pgTable("coordinator_api_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
});

export const coordinatorKnowledgeCommits = pgTable("coordinator_knowledge_commits", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  version: text("version").notNull(),
  candidateIdsJson: text("candidate_ids_json").notNull(),
  decisionRecordId: text("decision_record_id"),
  committedBy: text("committed_by").notNull(),
  committedAt: timestamp("committed_at", { withTimezone: true, mode: "string" }).notNull(),
  contentJson: text("content_json"),
});

/** Fan-out table for Postgres NOTIFY payloads (SSE / multi-instance). */
export const coordinatorBroadcastEvents = pgTable("coordinator_broadcast_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  envelopeJson: text("envelope_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});
