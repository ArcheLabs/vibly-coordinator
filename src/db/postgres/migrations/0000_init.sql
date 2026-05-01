CREATE TABLE IF NOT EXISTS "coordinator_projections" (
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"version" text,
	"data_json" text NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "coordinator_projections_kind_id_pk" PRIMARY KEY("kind","id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_coordinator_projections_kind" ON "coordinator_projections" ("kind");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coordinator_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"holder_id" text NOT NULL,
	"expires_at" timestamptz NOT NULL,
	"created_at" timestamptz NOT NULL,
	"renewed_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_coordinator_leases_resource" ON "coordinator_leases" ("kind","resource_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_coordinator_leases_expires" ON "coordinator_leases" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coordinator_api_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"label" text,
	"created_at" timestamptz NOT NULL,
	"revoked_at" timestamptz
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coordinator_knowledge_commits" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"version" text NOT NULL,
	"candidate_ids_json" text NOT NULL,
	"decision_record_id" text,
	"committed_by" text NOT NULL,
	"committed_at" timestamptz NOT NULL,
	"content_json" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_coordinator_knowledge_commits_project" ON "coordinator_knowledge_commits" ("project_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coordinator_broadcast_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"envelope_json" text NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
