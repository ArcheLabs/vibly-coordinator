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

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function createCoordinatorPostgres(databaseUrl: string): CoordinatorPostgresClients {
  const sql = postgres(databaseUrl, {
    max: positiveIntEnv("POSTGRES_POOL_MAX", 4),
    idle_timeout: positiveIntEnv("POSTGRES_IDLE_TIMEOUT_SECONDS", 20),
    connect_timeout: positiveIntEnv("POSTGRES_CONNECT_TIMEOUT_SECONDS", 10),
    max_lifetime: positiveIntEnv("POSTGRES_MAX_LIFETIME_SECONDS", 1800),
  });
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
