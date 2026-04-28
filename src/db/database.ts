import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

let instance: DatabaseSync | null = null;

export function openDatabase(databaseUrl: string): DatabaseSync {
  if (instance) return instance;

  // Parse file: URL  (e.g. "file:./data/vibly-coordinator.sqlite")
  const filePath = databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl;
  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  instance = new DatabaseSync(resolvedPath);
  return instance;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export type { DatabaseSync as Database };
