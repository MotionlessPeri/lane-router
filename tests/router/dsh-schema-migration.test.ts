import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { expect, test } from "vitest";

import { openRouterDatabase } from "../../src/router/database.js";
import { ROUTER_SCHEMA_VERSION } from "../../src/router/schema.js";

function writeDatabase(version: 6 | 7, dangling: boolean): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "lane-router-dsh-migration-"));
  const path = join(root, "router.sqlite");
  const raw = new Database(path);
  raw.pragma("foreign_keys = OFF");
  raw.exec(`
    CREATE TABLE lane (id TEXT PRIMARY KEY,address TEXT NOT NULL,project TEXT NOT NULL,role_description TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,model TEXT,archived_at INTEGER);
    CREATE TABLE binding (id TEXT PRIMARY KEY,lane_id TEXT NOT NULL REFERENCES lane(id),backend TEXT NOT NULL CHECK (backend IN ('claude','codex'${version === 7 ? ",'dsh'" : ""})),conversation_id TEXT NOT NULL,generation INTEGER NOT NULL CHECK (generation > 0),startup_json TEXT NOT NULL,active_at INTEGER NOT NULL,inactive_at INTEGER,cwd TEXT);
    CREATE UNIQUE INDEX binding_active_lane_idx ON binding(lane_id) WHERE inactive_at IS NULL;
    CREATE UNIQUE INDEX binding_active_conversation_idx ON binding(backend,conversation_id) WHERE inactive_at IS NULL;
    CREATE UNIQUE INDEX binding_lane_generation_idx ON binding(lane_id,generation);
    CREATE TABLE message (id TEXT PRIMARY KEY);
    CREATE TABLE message_archive (id TEXT PRIMARY KEY);
    INSERT INTO lane VALUES('lane-1','alpha/a','alpha','a',1,1,NULL,NULL);
    INSERT INTO binding VALUES('binding-1','${dangling ? "missing-lane" : "lane-1"}','claude','session',7,'{}',2,NULL,NULL);
  `);
  raw.pragma(`user_version = ${version}`); raw.close();
  return { root, path };
}

test("schema 6 migration preserves generations and adds only the dsh backend value", () => {
  const { root, path } = writeDatabase(6, false);
  const database = openRouterDatabase(path);
  try {
    expect(database.pragma("user_version", { simple: true })).toBe(ROUTER_SCHEMA_VERSION);
    expect(database.prepare("SELECT backend,generation FROM binding WHERE id='binding-1'").get()).toEqual({ backend: "claude", generation: 7 });
    expect(() => database.prepare("INSERT INTO binding VALUES('binding-2','lane-1','dsh','host-session',8,'{}',3,4,NULL)").run()).not.toThrow();
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("schema 6 migration rolls back when foreign keys are already corrupt", () => {
  const { root, path } = writeDatabase(6, true);
  expect(() => openRouterDatabase(path)).toThrow(/dangling references/i);
  const raw = new Database(path);
  try {
    expect(raw.pragma("user_version", { simple: true })).toBe(6);
    expect(raw.prepare("SELECT generation FROM binding WHERE id='binding-1'").get()).toEqual({ generation: 7 });
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='binding_legacy'").get()).toBeUndefined();
  } finally { raw.close(); rmSync(root, { recursive: true, force: true }); }
});

test("opening an already-current schema rejects foreign key corruption", () => {
  const { root, path } = writeDatabase(7, true);
  try { expect(() => openRouterDatabase(path)).toThrow(/dangling references/i); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
