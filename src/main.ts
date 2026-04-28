import { loadConfig } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { openDatabase } from "./db/database.js";
import { runMigrations } from "./db/migrations.js";
import { CoordinatorStore } from "./db/coordinatorStore.js";
import { getOrCreateConcord } from "./sdk/createConcord.js";
import { createEventBus } from "./services/eventBus.js";
import { createApp } from "./createApp.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info({ coordinatorId: config.coordinatorId, storageMode: config.storageMode }, "Starting Vibly Coordinator");

  // Initialize database (only for sqlite mode)
  let coordinatorStore: import("./db/coordinatorStore.js").CoordinatorStore;
  if (config.storageMode === "sqlite") {
    const db = openDatabase(config.databaseUrl);
    runMigrations(db);
    coordinatorStore = new CoordinatorStore(db);
    logger.info("Database migrations complete");
  } else {
    // Memory mode: use in-memory SQLite (:memory:)
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    coordinatorStore = new CoordinatorStore(db);
  }

  const concord = getOrCreateConcord(config);
  const eventBus = createEventBus();

  const app = await createApp({ config, logger, concord, coordinatorStore, eventBus });

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
