import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { loadConfig } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { openDatabase } from "./db/database.js";
import { runMigrations } from "./db/migrations.js";
import { SqliteCoordinatorStore } from "./db/coordinatorStore.js";
import type { CoordinatorStorePort } from "./db/coordinatorStorePort.js";
import { DrizzleCoordinatorStore } from "./db/drizzleCoordinatorStore.js";
import { createCoordinatorPostgres, pingPostgres, runCoordinatorPostgresMigrations } from "./db/postgres/client.js";
import { getOrCreateConcord } from "./sdk/createConcord.js";
import { createInMemoryEventBus, createPostgresEventBus, type EventBus } from "./services/eventBus.js";
import { createApp } from "./createApp.js";
import { startTracingIfConfigured } from "./telemetry/tracing.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const tracing = startTracingIfConfigured(config);

  logger.info({ coordinatorId: config.coordinatorId, storageMode: config.storageMode }, "Starting Vibly Coordinator");

  let coordinatorStore: CoordinatorStorePort;
  let eventBus: EventBus;
  let pgSql: postgres.Sql | undefined;
  const dispose: Array<() => Promise<void>> = [];

  if (config.storageMode === "postgres") {
    const pg = createCoordinatorPostgres(config.databaseUrl);
    pgSql = pg.sql;
    await runCoordinatorPostgresMigrations(pg.sql);
    coordinatorStore = new DrizzleCoordinatorStore(pg.db);
    eventBus = createPostgresEventBus({ sql: pg.sql, logger });
    dispose.push(async () => {
      await eventBus.close?.();
      await pg.close();
    });
    logger.info("Postgres migrations complete");
  } else if (config.storageMode === "sqlite") {
    const db = openDatabase(config.databaseUrl);
    runMigrations(db);
    coordinatorStore = new SqliteCoordinatorStore(db);
    eventBus = createInMemoryEventBus();
    logger.info("SQLite migrations complete");
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    coordinatorStore = new SqliteCoordinatorStore(db);
    eventBus = createInMemoryEventBus();
  }

  const concord = getOrCreateConcord(config);

  const readinessProbe = pgSql ? () => pingPostgres(pgSql) : undefined;

  const app = await createApp({
    config,
    logger,
    concord,
    coordinatorStore,
    eventBus,
    readinessProbe,
    requestIdGenerator: () => randomUUID(),
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    try {
      app.governanceBackendRegistry.stopAll();
      await app.close();
      for (const fn of dispose) await fn();
      await tracing?.shutdown();
    } catch (err) {
      logger.error(err, "Error during shutdown");
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    const address = await app.listen({ host: config.host, port: config.port });
    logger.info({ address, docs: `${address}/docs` }, "Vibly Coordinator running");
  } catch (err) {
    logger.error(err, "Failed to start server");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
