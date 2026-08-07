import Database from "better-sqlite3";

import { initializeRouterSchema } from "./schema.js";

export type RouterDatabase = Database.Database;

export function openRouterDatabase(path: string): RouterDatabase {
  const database = new Database(path);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    initializeRouterSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function routerTransaction<T>(database: RouterDatabase, work: () => T): T {
  return database.transaction(work)();
}
