import { unlinkSync, existsSync } from "node:fs";
import { openDatabase } from "./database.js";
import { runMigrations } from "./migrations.js";

const url = process.env.DATABASE_URL ?? "file:./data/coordinator.db";
const filePath = url.replace(/^file:/, "");

if (existsSync(filePath)) {
  unlinkSync(filePath);
  console.log(`Removed ${filePath}`);
}

const db = openDatabase(url);
runMigrations(db);
console.log("Database reset complete.");
