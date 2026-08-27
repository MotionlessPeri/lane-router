import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openRouterDatabase } from "../../src/router/database.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Pinned copy of the version 1 shape. It must not be imported from schema.ts: the point of a
// migration test is to start from the historical table, not from whatever the current one is.
const SCHEMA_V1_SQL = `
CREATE TABLE lane (
  address TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  role_description TEXT NOT NULL CHECK (length(trim(role_description)) > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX lane_project_address_idx ON lane(project,address);

CREATE TABLE binding (
  id TEXT PRIMARY KEY,
  lane_address TEXT NOT NULL REFERENCES lane(address) ON DELETE RESTRICT,
  backend TEXT NOT NULL CHECK (backend IN ('claude','codex')),
  conversation_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  startup_json TEXT NOT NULL,
  active_at INTEGER NOT NULL,
  inactive_at INTEGER
);

CREATE UNIQUE INDEX binding_active_lane_idx
  ON binding(lane_address) WHERE inactive_at IS NULL;
CREATE UNIQUE INDEX binding_active_conversation_idx
  ON binding(backend,conversation_id) WHERE inactive_at IS NULL;
CREATE UNIQUE INDEX binding_lane_generation_idx
  ON binding(lane_address,generation);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  sender_lane TEXT NOT NULL REFERENCES lane(address) ON DELETE RESTRICT,
  target_lane TEXT NOT NULL REFERENCES lane(address) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('normal','correction')),
  reply_to TEXT REFERENCES message(id) ON DELETE RESTRICT,
  relative_path TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','resolved')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  ack_lane TEXT REFERENCES lane(address) ON DELETE RESTRICT,
  ack_generation INTEGER,
  notification_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (notification_state IN ('pending','notified')),
  CHECK (
    (state='pending' AND resolved_at IS NULL AND ack_lane IS NULL AND ack_generation IS NULL) OR
    (state='resolved' AND resolved_at IS NOT NULL AND ack_lane IS NOT NULL AND ack_generation > 0)
  )
);

CREATE INDEX message_target_state_idx ON message(target_lane,state,created_at,id);
`;

const SHA = "a".repeat(64);

function writeVersion1Database(): string {
  const root = mkdtempSync(join(tmpdir(), "lane-router-migration-"));
  roots.push(root);
  const path = join(root, "router.sqlite");
  const database = new Database(path);
  database.exec(SCHEMA_V1_SQL);
  database.pragma("user_version = 1");
  for (const address of ["alpha/source", "alpha/target"]) {
    database.prepare("INSERT INTO lane(address,project,role_description,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run(address, "alpha", address, 1, 1);
  }
  const insert = database.prepare(`
    INSERT INTO message(id,request_key,sender_lane,target_lane,kind,reply_to,relative_path,
      content_sha256,state,created_at,resolved_at,ack_lane,ack_generation,notification_state)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  insert.run("m-untried", "req-1", "alpha/source", "alpha/target", "normal", null, "p/1.md", SHA, "pending", 10, null, null, null, "pending");
  insert.run("m-notified", "req-2", "alpha/source", "alpha/target", "normal", null, "p/2.md", SHA, "pending", 11, null, null, null, "notified");
  insert.run("m-resolved", "req-3", "alpha/source", "alpha/target", "correction", "m-notified", "r/3.md", SHA, "resolved", 12, 13, "alpha/target", 1, "notified");
  database.close();
  return path;
}

describe("router schema migration 1 to 2", () => {
  it("widens notification_state and maps the historical value exactly", () => {
    const path = writeVersion1Database();
    const database = openRouterDatabase(path);
    try {
      // Opening always lands on the current version; the subject here is the value mapping.
      expect(database.pragma("user_version", { simple: true })).toBe(4);

      const rows = database.prepare("SELECT id,notification_state FROM message ORDER BY id").all() as Array<{ id: string; notification_state: string }>;
      expect(rows).toEqual([
        { id: "m-notified", notification_state: "sent" },
        { id: "m-resolved", notification_state: "sent" },
        { id: "m-untried", notification_state: "pending" },
      ]);
    } finally { database.close(); }
  });

  it("preserves every row and every other column", () => {
    const path = writeVersion1Database();
    const before = new Database(path);
    const original = before.prepare(`
      SELECT id,request_key,sender_lane,target_lane,kind,reply_to,relative_path,content_sha256,
        state,created_at,resolved_at,ack_lane,ack_generation FROM message ORDER BY id
    `).all();
    before.close();

    const database = openRouterDatabase(path);
    try {
      const after = database.prepare(`
        SELECT id,request_key,sender_lane,target_lane,kind,reply_to,relative_path,content_sha256,
          state,created_at,resolved_at,ack_lane,ack_generation FROM message ORDER BY id
      `).all();
      expect(after).toEqual(original);
    } finally { database.close(); }
  });

  it("accepts the four outcome values and still rejects an unknown one", () => {
    const database = openRouterDatabase(writeVersion1Database());
    try {
      const update = database.prepare("UPDATE message SET notification_state=? WHERE id='m-untried'");
      for (const value of ["sent", "deferred", "no_channel", "send_failed", "pending"]) {
        expect(() => update.run(value)).not.toThrow();
      }
      expect(() => update.run("notified")).toThrow(/constraint/iu);
    } finally { database.close(); }
  });

  it("keeps foreign keys and the resolved-row invariant enforceable after the rebuild", () => {
    const database = openRouterDatabase(writeVersion1Database());
    try {
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.pragma("foreign_key_check")).toEqual([]);

      const insert = database.prepare(`
        INSERT INTO message(id,request_key,sender_lane,target_lane,kind,reply_to,relative_path,
          content_sha256,state,created_at,resolved_at,ack_lane,ack_generation,notification_state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      // reply_to must still point at a real message row after the table was rebuilt.
      expect(() => insert.run("m-bad", "req-9", "alpha/source", "alpha/target", "correction", "missing",
        "p/9.md", SHA, "pending", 20, null, null, null, "pending")).toThrow(/foreign key/iu);
      // The resolved-row CHECK must survive the rebuild too.
      expect(() => insert.run("m-bad2", "req-10", "alpha/source", "alpha/target", "normal", null,
        "p/10.md", SHA, "resolved", 20, null, null, null, "pending")).toThrow(/constraint/iu);
    } finally { database.close(); }
  });

  it("refuses a database from an unknown future version", () => {
    const path = writeVersion1Database();
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    expect(() => openRouterDatabase(path)).toThrow(/not supported/iu);
  });
});

// Version 2 differs from version 1 only in the widened notification_state vocabulary; deriving the
// pinned copy from the pinned version 1 keeps both historical, without importing from schema.ts.
const SCHEMA_V2_SQL = SCHEMA_V1_SQL.replace(
  "CHECK (notification_state IN ('pending','notified'))",
  "CHECK (notification_state IN ('pending','sent','deferred','no_channel','send_failed'))",
);

function writeVersion2Database(): string {
  const root = mkdtempSync(join(tmpdir(), "lane-router-migration-"));
  roots.push(root);
  const path = join(root, "router.sqlite");
  const database = new Database(path);
  database.exec(SCHEMA_V2_SQL);
  database.pragma("user_version = 2");
  database.prepare("INSERT INTO lane(address,project,role_description,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run("alpha/design", "alpha", "design", 1, 1);
  database.prepare(`
    INSERT INTO binding(id,lane_address,backend,conversation_id,generation,startup_json,active_at,inactive_at)
    VALUES('binding-1','alpha/design','claude','session-1',1,'{}',5,NULL)
  `).run();
  database.close();
  return path;
}

describe("router schema migration 2 to 3", () => {
  it("adds a nullable cwd column and keeps the existing binding row untouched", () => {
    const database = openRouterDatabase(writeVersion2Database());
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(4);
      const columns = database.pragma("table_info(binding)") as Array<{ name: string; notnull: number }>;
      expect(columns.find((column) => column.name === "cwd")).toMatchObject({ notnull: 0 });
      expect(database.prepare("SELECT id,lane_address,backend,conversation_id,generation,startup_json,active_at,inactive_at,cwd FROM binding").get())
        .toEqual({
          id: "binding-1", lane_address: "alpha/design", backend: "claude", conversation_id: "session-1",
          generation: 1, startup_json: "{}", active_at: 5, inactive_at: null, cwd: null,
        });
      expect(() => database.prepare("UPDATE binding SET cwd='E:\\\\project' WHERE id='binding-1'").run()).not.toThrow();
    } finally { database.close(); }
  });

  it("migrates a version 1 database through every intermediate shape to the current one", () => {
    const database = openRouterDatabase(writeVersion1Database());
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(4);
      const columns = database.pragma("table_info(binding)") as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("cwd");
      // The version 1 mapping must still have happened on the way through.
      expect(database.prepare("SELECT notification_state FROM message WHERE id='m-notified'").get())
        .toEqual({ notification_state: "sent" });
    } finally { database.close(); }
  });
});

const SCHEMA_V3_SQL = `${SCHEMA_V2_SQL}
ALTER TABLE binding ADD COLUMN cwd TEXT;`;

function writeVersion3Database(): string {
  const root = mkdtempSync(join(tmpdir(), "lane-router-migration-"));
  roots.push(root);
  const path = join(root, "router.sqlite");
  const database = new Database(path);
  database.exec(SCHEMA_V3_SQL);
  database.pragma("user_version = 3");
  for (const [address, role] of [["alpha/design", "design"], ["alpha/review", "review"]]) {
    database.prepare("INSERT INTO lane(address,project,role_description,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run(address, "alpha", role, 1, 1);
  }
  database.close();
  return path;
}

describe("router schema migration 3 to 4", () => {
  it("adds a nullable model column and leaves every existing lane exactly as it was", () => {
    const database = openRouterDatabase(writeVersion3Database());
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(4);
      const columns = database.pragma("table_info(lane)") as Array<{ name: string; notnull: number }>;
      expect(columns.find((column) => column.name === "model")).toMatchObject({ notnull: 0 });

      // Untouched means every column, not just a count: a lane that never declared a model must
      // read exactly as before with model NULL, which is what keeps existing lanes on today's
      // behaviour rather than on some default this migration invented.
      expect(database.prepare("SELECT address,project,role_description,created_at,updated_at,model FROM lane ORDER BY address").all())
        .toEqual([
          { address: "alpha/design", project: "alpha", role_description: "design", created_at: 1, updated_at: 1, model: null },
          { address: "alpha/review", project: "alpha", role_description: "review", created_at: 1, updated_at: 1, model: null },
        ]);
      expect(() => database.prepare("UPDATE lane SET model='claude-opus-5' WHERE address='alpha/design'").run()).not.toThrow();
    } finally { database.close(); }
  });

  it("keeps the table rather than rebuilding it, so nothing else can be lost on the way", () => {
    const database = openRouterDatabase(writeVersion3Database());
    try {
      // A rebuild would have to recreate this index; ALTER TABLE ADD COLUMN carries it through.
      const indexes = database.pragma("index_list(lane)") as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain("lane_project_address_idx");
    } finally { database.close(); }
  });
});
