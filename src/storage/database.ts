import Database from "better-sqlite3";

import { migrateDatabase } from "./migrations.js";

export type RouterDatabase = Database.Database;

export function openDatabase(path: string): RouterDatabase {
  const database = new Database(path);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    migrateDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function inTransaction<T>(
  database: RouterDatabase,
  work: () => T,
): T {
  return database.transaction(work)();
}
