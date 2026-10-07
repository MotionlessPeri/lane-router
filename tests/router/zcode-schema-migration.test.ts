import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { expect, test, vi } from "vitest";

import { openRouterDatabase } from "../../src/router/database.js";
import { initializeRouterSchema, ROUTER_SCHEMA_VERSION } from "../../src/router/schema.js";

function writeDatabase(version: 7 | 8, dangling: boolean): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "lane-router-zcode-migration-"));
  const path = join(root, "router.sqlite");
  const raw = new Database(path);
  raw.pragma("foreign_keys = OFF");
  raw.exec(`
    CREATE TABLE lane (id TEXT PRIMARY KEY,address TEXT NOT NULL,project TEXT NOT NULL,role_description TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,model TEXT,archived_at INTEGER);
    CREATE TABLE binding (id TEXT PRIMARY KEY,lane_id TEXT NOT NULL REFERENCES lane(id),backend TEXT NOT NULL CHECK (backend IN ('claude','codex','dsh'${version === 8 ? ",'zcode'" : ""})),conversation_id TEXT NOT NULL,generation INTEGER NOT NULL CHECK (generation > 0),startup_json TEXT NOT NULL,active_at INTEGER NOT NULL,inactive_at INTEGER,cwd TEXT);
    CREATE UNIQUE INDEX binding_active_lane_idx ON binding(lane_id) WHERE inactive_at IS NULL;
    CREATE UNIQUE INDEX binding_active_conversation_idx ON binding(backend,conversation_id) WHERE inactive_at IS NULL;
    CREATE UNIQUE INDEX binding_lane_generation_idx ON binding(lane_id,generation);
    CREATE TABLE message (id TEXT PRIMARY KEY);
    CREATE TABLE message_archive (id TEXT PRIMARY KEY);
    INSERT INTO lane VALUES('lane-1','alpha/a','alpha','a',1,1,NULL,NULL);
    INSERT INTO binding VALUES('binding-1','${dangling ? "missing-lane" : "lane-1"}','claude','session',7,'{}',2,NULL,NULL);
    INSERT INTO binding VALUES('binding-2','lane-1','dsh','host-session',3,'{}',4,5,NULL);
  `);
  raw.pragma(`user_version = ${version}`); raw.close();
  return { root, path };
}

test("schema 7 migration preserves rows and generations and adds only the zcode backend value", () => {
  const { root, path } = writeDatabase(7, false);
  const database = openRouterDatabase(path);
  try {
    expect(database.pragma("user_version", { simple: true })).toBe(ROUTER_SCHEMA_VERSION);
    // A rebuild is the one migration shape that can drop rows silently, so the count is asserted
    // rather than trusted, and the pre-existing values must read back exactly as they were.
    expect(database.prepare("SELECT COUNT(*) AS n FROM binding").get()).toEqual({ n: 2 });
    expect(database.prepare("SELECT backend,generation FROM binding WHERE id='binding-1'").get()).toEqual({ backend: "claude", generation: 7 });
    expect(database.prepare("SELECT backend,generation FROM binding WHERE id='binding-2'").get()).toEqual({ backend: "dsh", generation: 3 });
    // Inserted inactive on purpose: the one-active-binding-per-lane index would otherwise fire
    // first, and the claim under test is the backend CHECK, not lane exclusivity.
    expect(() => database.prepare("INSERT INTO binding VALUES('binding-3','lane-1','zcode','zcode-session',8,'{}',6,7,NULL)").run()).not.toThrow();
    expect(() => database.prepare("INSERT INTO binding VALUES('binding-4','lane-1','unknown','session',9,'{}',8,9,NULL)").run()).toThrow(/constraint/iu);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("schema 7 migration rolls back when foreign keys are already corrupt", () => {
  const { root, path } = writeDatabase(7, true);
  expect(() => openRouterDatabase(path)).toThrow(/dangling references/i);
  const raw = new Database(path);
  try {
    expect(raw.pragma("user_version", { simple: true })).toBe(7);
    expect(raw.prepare("SELECT generation FROM binding WHERE id='binding-1'").get()).toEqual({ generation: 7 });
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='binding_legacy'").get()).toBeUndefined();
  } finally { raw.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a failure inside the version 8 migration leaves the version 7 shape committed", () => {
  const { root, path } = writeDatabase(7, false);
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  const exec = database.exec.bind(database);
  vi.spyOn(database, "exec").mockImplementation((sql) => {
    if (sql.includes("'zcode'")) throw new Error("injected version 8 failure");
    return exec(sql);
  });
  try {
    expect(() => initializeRouterSchema(database)).toThrow(/injected version 8 failure/);
    expect(database.pragma("user_version", { simple: true })).toBe(7);
    const bindingSql = (database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='binding'").get() as { sql: string }).sql;
    expect(bindingSql).toContain("'dsh'");
    expect(bindingSql).not.toContain("'zcode'");
    expect(database.prepare("SELECT COUNT(*) AS n FROM binding").get()).toEqual({ n: 2 });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='binding_legacy'").get()).toBeUndefined();
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("opening an already-current schema rejects foreign key corruption", () => {
  const { root, path } = writeDatabase(8, true);
  try { expect(() => openRouterDatabase(path)).toThrow(/dangling references/i); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
