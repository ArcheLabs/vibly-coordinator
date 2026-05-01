import { createSQLiteConcord, createConcord } from "@concord/sdk";
import type { Concord } from "@concord/sdk";
import type { CoordinatorConfig } from "../config/env.js";

let concordInstance: Concord | null = null;

export function getOrCreateConcord(config: CoordinatorConfig): Concord {
  if (concordInstance) return concordInstance;

  if (config.storageMode === "sqlite") {
    const filename = config.databaseUrl.startsWith("file:")
      ? config.databaseUrl.slice(5)
      : config.databaseUrl;
    concordInstance = createSQLiteConcord(filename);
  } else {
    concordInstance = createConcord();
  }

  return concordInstance;
}

export function resetConcord(): void {
  concordInstance = null;
}
