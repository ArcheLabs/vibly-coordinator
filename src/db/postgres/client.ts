import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CoordinatorPostgresClients {
  sql: postgres.Sql;
  db: ReturnType<typeof drizzle<typeof schema>>;
  close: () => Promise<void>;
}

export function createCoordinatorPostgres(databaseUrl: string): CoordinatorPostgresClients {
  const sql = postgres(databaseUrl, { max: 12 });
  const db = drizzle(sql, { schema });
  return {
    sql,
    db,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export async function runCoordinatorPostgresMigrations(sql: postgres.Sql): Promise<void> {
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: join(__dirname, "migrations") });
}

export async function pingPostgres(sql: postgres.Sql): Promise<void> {
  await sql`select 1`;
}
