import { openDatabase } from "./database.js";
import { runMigrations } from "./migrations.js";

const url = process.env.DATABASE_URL ?? "file:./data/coordinator.db";
const db = openDatabase(url);
runMigrations(db);
console.log("Migrations complete.");
