import { z } from "zod";
import { openDatabase } from "./database.js";
import { runMigrations } from "./migrations.js";
import { createCoordinatorPostgres, runCoordinatorPostgresMigrations } from "./postgres/client.js";

/** Migration CLI only reads storage + URL so it can run under NODE_ENV=production without OIDC env. */
const migrateEnvSchema = z.object({
  STORAGE_MODE: z.enum(["memory", "sqlite", "postgres"]).default("sqlite"),
  DATABASE_URL: z.string().default("file:./data/vibly-coordinator.sqlite"),
});

async function main() {
  const { STORAGE_MODE, DATABASE_URL } = migrateEnvSchema.parse(process.env);

  if (STORAGE_MODE === "postgres") {
    const pg = createCoordinatorPostgres(DATABASE_URL);
    try {
      await runCoordinatorPostgresMigrations(pg.sql);
    } finally {
      await pg.close();
    }
    console.log("Postgres migrations complete.");
    return;
  }

  if (STORAGE_MODE === "memory") {
    console.error("STORAGE_MODE=memory has no on-disk migrations; use sqlite or postgres for db:migrate.");
    process.exit(1);
  }

  const db = openDatabase(DATABASE_URL);
  runMigrations(db);
  console.log("SQLite migrations complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
