import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openRouterDatabase } from "../../src/router/database.js";
import { initializeRouterSchema, ROUTER_SCHEMA_VERSION } from "../../src/router/schema.js";
import {
  BINDING_BACKENDS, SCHEMA_V6_SQL, schemaSql, STARTING_SHAPES, type StartingShape,
} from "../fixtures/router/schema-shapes.js";

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
      expect(database.pragma("user_version", { simple: true })).toBe(ROUTER_SCHEMA_VERSION);

      const rows = database.prepare("SELECT id,notification_state FROM message ORDER BY id").all() as Array<{ id: string; notification_state: string }>;
      expect(rows).toEqual([
        { id: "m-notified", notification_state: "sent" },
        { id: "m-resolved", notification_state: "sent" },
        { id: "m-untried", notification_state: "pending" },
      ]);
    } finally { database.close(); }
  });

  // The lane columns became ids in version 6, so they are compared through the lane table: what
  // has to survive every migration is which lane each message names, not how it is spelled.
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
        SELECT m.id,m.request_key,s.address AS sender_lane,t.address AS target_lane,m.kind,m.reply_to,
          m.relative_path,m.content_sha256,m.state,m.created_at,m.resolved_at,a.address AS ack_lane,m.ack_generation
        FROM message m
        JOIN lane s ON s.id=m.sender_lane_id
        JOIN lane t ON t.id=m.target_lane_id
        LEFT JOIN lane a ON a.id=m.ack_lane_id
        ORDER BY m.id
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
      const lane = (database.prepare("SELECT id FROM lane WHERE address='alpha/source'").get() as { id: string }).id;
      const other = (database.prepare("SELECT id FROM lane WHERE address='alpha/target'").get() as { id: string }).id;

      const insert = database.prepare(`
        INSERT INTO message(id,request_key,sender_lane_id,target_lane_id,kind,reply_to,relative_path,
          content_sha256,state,created_at,resolved_at,ack_lane_id,ack_generation,notification_state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      // A message must still name lanes that exist — those references survived the rebuild as keys.
      expect(() => insert.run("m-bad", "req-9", lane, "no-such-lane", "normal", null,
        "p/9.md", SHA, "pending", 20, null, null, null, "pending")).toThrow(/foreign key/iu);
      // But reply_to is deliberately no longer one: the message it names can be archived out of
      // this table, and a key here would make archiving that message fail.
      expect(() => insert.run("m-orphan-reply", "req-11", lane, other, "correction", "gone-to-archive",
        "p/11.md", SHA, "pending", 21, null, null, null, "pending")).not.toThrow();
      // The resolved-row CHECK must survive the rebuild too.
      expect(() => insert.run("m-bad2", "req-10", lane, other, "normal", null,
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
      expect(database.pragma("user_version", { simple: true })).toBe(ROUTER_SCHEMA_VERSION);
      const columns = database.pragma("table_info(binding)") as Array<{ name: string; notnull: number }>;
      expect(columns.find((column) => column.name === "cwd")).toMatchObject({ notnull: 0 });
      // The binding names its lane by id from version 6 on, so the address is read through the join.
      expect(database.prepare(`
        SELECT b.id,l.address AS lane_address,b.backend,b.conversation_id,b.generation,b.startup_json,b.active_at,b.inactive_at,b.cwd
        FROM binding b JOIN lane l ON l.id=b.lane_id
      `).get())
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
      expect(database.pragma("user_version", { simple: true })).toBe(ROUTER_SCHEMA_VERSION);
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
      expect(database.pragma("user_version", { simple: true })).toBe(ROUTER_SCHEMA_VERSION);
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

const SCHEMA_V4_SQL = `${SCHEMA_V3_SQL}
ALTER TABLE lane ADD COLUMN model TEXT;`;

function writeVersion4Database(): string {
  const root = mkdtempSync(join(tmpdir(), "lane-router-migration-"));
  roots.push(root);
  const path = join(root, "router.sqlite");
  const database = new Database(path);
  database.exec(SCHEMA_V4_SQL);
  database.pragma("user_version = 4");
  database.prepare("INSERT INTO lane(address,project,role_description,created_at,updated_at,model) VALUES(?,?,?,?,?,?)")
    .run("alpha/design", "alpha", "design", 1, 1, "claude-opus-5");
  database.prepare("INSERT INTO lane(address,project,role_description,created_at,updated_at,model) VALUES(?,?,?,?,?,?)")
    .run("alpha/plain", "alpha", "plain", 1, 1, null);
  database.close();
  return path;
}

describe("router schema migration 4 to 5", () => {
  // The column is still spelled `retired_at` in the database while every layer above it says
  // archived. Renaming it would be a migration carried forever to undo a word, and the column is
  // about to stop existing anyway — so the divergence is mapped in `mapLane`, not migrated.
  it("adds a nullable out-of-service column and leaves every existing lane exactly as it was", () => {
    const database = openRouterDatabase(writeVersion4Database());
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(ROUTER_SCHEMA_VERSION);
      const columns = database.pragma("table_info(lane)") as Array<{ name: string; notnull: number }>;
      expect(columns.find((column) => column.name === "archived_at")).toMatchObject({ notnull: 0 });

      // Every column, not a row count: an existing lane must read exactly as before with the new
      // column NULL, which is what keeps all 25 of them in service rather than archiving them
      // wholesale on upgrade. The model column from version 4 has to survive too.
      expect(database.prepare("SELECT address,project,role_description,created_at,updated_at,model,archived_at FROM lane ORDER BY address").all())
        .toEqual([
          { address: "alpha/design", project: "alpha", role_description: "design", created_at: 1, updated_at: 1, model: "claude-opus-5", archived_at: null },
          { address: "alpha/plain", project: "alpha", role_description: "plain", created_at: 1, updated_at: 1, model: null, archived_at: null },
        ]);
    } finally { database.close(); }
  });

  it("keeps the table rather than rebuilding it, so nothing else can be lost on the way", () => {
    const database = openRouterDatabase(writeVersion4Database());
    try {
      const indexes = database.pragma("index_list(lane)") as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain("lane_project_address_idx");
    } finally { database.close(); }
  });
});

// Version 5 named the column `retired_at`, and it still does: renaming a column that is about to
// stop existing would mean a migration carried forever to undo a word. What changed is the word
// every layer above the database uses, which is why this reads the storage name and asserts the
// record field is the archived one.
const SCHEMA_V5_SQL = `${SCHEMA_V4_SQL}
ALTER TABLE lane ADD COLUMN retired_at INTEGER;`;

/**
 * A version 5 database with something in every table, because the version 6 migration rebuilds all
 * three and re-points four foreign keys. An empty fixture would let "rebuild and lose the rows"
 * pass, which is the one failure this migration can produce that nothing downstream can undo.
 */
function writeVersion5Database(options: { populated: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "lane-router-migration-"));
  roots.push(root);
  const path = join(root, "router.sqlite");
  const database = new Database(path);
  database.exec(SCHEMA_V5_SQL);
  database.pragma("user_version = 5");
  if (!options.populated) { database.close(); return path; }

  const lane = database.prepare("INSERT INTO lane(address,project,role_description,created_at,updated_at,model,retired_at) VALUES(?,?,?,?,?,?,?)");
  lane.run("alpha/gone", "alpha", "gone", 1, 2, "claude-opus-5", 1_788_182_366_359);
  lane.run("alpha/here", "alpha", "here", 1, 2, null, null);
  lane.run("beta/other", "beta", "other", 1, 2, null, null);
  database.prepare(`
    INSERT INTO binding(id,lane_address,backend,conversation_id,generation,startup_json,active_at,inactive_at,cwd)
    VALUES('binding-1','alpha/here','claude','session-1',1,'{}',5,NULL,'E:\\project')
  `).run();
  const message = database.prepare(`
    INSERT INTO message(id,request_key,sender_lane,target_lane,kind,reply_to,relative_path,
      content_sha256,state,created_at,resolved_at,ack_lane,ack_generation,notification_state)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  message.run("m-1", "req-1", "alpha/here", "alpha/gone", "normal", null, "a/1.md", SHA, "pending", 10, null, null, null, "sent");
  message.run("m-2", "req-2", "alpha/gone", "beta/other", "normal", null, "b/2.md", SHA, "pending", 11, null, null, null, "sent");
  message.run("m-3", "req-3", "alpha/here", "beta/other", "correction", "m-2", "b/3.md", SHA, "resolved", 12, 13, "beta/other", 2, "sent");
  database.close();
  return path;
}

describe("router schema migration 5 to 6", () => {
  it("commits the fixed version 6 binding table before a later step fails", () => {
    const path = writeVersion5Database({ populated: true });
    const database = new Database(path);
    database.pragma("foreign_keys = ON");
    const exec = database.exec.bind(database);
    vi.spyOn(database, "exec").mockImplementation((sql) => {
      if (sql.includes("'dsh'")) throw new Error("injected failure after version 6");
      return exec(sql);
    });
    try {
      expect(() => initializeRouterSchema(database)).toThrow(/injected failure after version 6/);
      expect(database.pragma("user_version", { simple: true })).toBe(6);
      const bindingSql = (database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='binding'").get() as { sql: string }).sql;
      expect(bindingSql).toContain("backend IN ('claude','codex')");
      expect(bindingSql).not.toContain("'dsh'");
      expect(database.prepare("SELECT generation FROM binding WHERE id='binding-1'").get()).toEqual({ generation: 1 });
    } finally { database.close(); }
  });

  // Every row in every rebuilt table, because a rebuild is the one migration shape that can lose
  // them silently: nothing downstream reads a count, so a dropped row would first be noticed as a
  // lane whose history had simply gone.
  it("rebuilds all three tables without losing a row", () => {
    const database = openRouterDatabase(writeVersion5Database({ populated: true }));
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(ROUTER_SCHEMA_VERSION);
      expect(database.prepare("SELECT COUNT(*) AS n FROM lane").get()).toEqual({ n: 3 });
      expect(database.prepare("SELECT COUNT(*) AS n FROM binding").get()).toEqual({ n: 1 });
      expect(database.prepare("SELECT COUNT(*) AS n FROM message").get()).toEqual({ n: 3 });
      // The archive table is created empty: this migration moves nothing, it only makes moving possible.
      expect(database.prepare("SELECT COUNT(*) AS n FROM message_archive").get()).toEqual({ n: 0 });
    } finally { database.close(); }
  });

  // An identity anchor is a lane that had already left service. Losing its timestamp would return
  // it to service, and the directory would look entirely normal afterwards.
  it("gives every lane an id and keeps the ones already out of service out of service", () => {
    const database = openRouterDatabase(writeVersion5Database({ populated: true }));
    try {
      const lanes = database.prepare("SELECT id,address,archived_at FROM lane ORDER BY address").all() as Array<{ id: string; address: string; archived_at: number | null }>;
      expect(lanes.map((lane) => lane.address)).toEqual(["alpha/gone", "alpha/here", "beta/other"]);
      expect(lanes[0]!.archived_at).toBe(1_788_182_366_359);
      expect(lanes.map((lane) => lane.archived_at)).toEqual([1_788_182_366_359, null, null]);
      // Distinct, non-empty ids: a migration that gave every row the same id would satisfy a
      // "has an id" assertion and destroy the thing the id exists for.
      expect(new Set(lanes.map((lane) => lane.id)).size).toBe(3);
      for (const lane of lanes) expect(lane.id).toMatch(/\S/u);
    } finally { database.close(); }
  });

  // The addresses are re-pointed by joining on what used to be the address, so a mistake here
  // would silently attach a binding or a message to the wrong lane rather than fail.
  it("re-points every foreign key at the lane it named before", () => {
    const database = openRouterDatabase(writeVersion5Database({ populated: true }));
    try {
      const byAddress = new Map((database.prepare("SELECT id,address FROM lane").all() as Array<{ id: string; address: string }>)
        .map((lane) => [lane.address, lane.id]));
      expect(database.prepare("SELECT lane_id FROM binding WHERE id='binding-1'").get())
        .toEqual({ lane_id: byAddress.get("alpha/here") });
      expect(database.prepare("SELECT sender_lane_id,target_lane_id,ack_lane_id FROM message WHERE id='m-3'").get())
        .toEqual({
          sender_lane_id: byAddress.get("alpha/here"),
          target_lane_id: byAddress.get("beta/other"),
          ack_lane_id: byAddress.get("beta/other"),
        });
      // A message sent by a lane that is already an anchor still points at it — that is what
      // keeping the row buys, and it is why these four keys stay foreign keys.
      expect(database.prepare("SELECT sender_lane_id,ack_lane_id FROM message WHERE id='m-2'").get())
        .toEqual({ sender_lane_id: byAddress.get("alpha/gone"), ack_lane_id: null });
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally { database.close(); }
  });

  // This is what the whole rework buys, so it is asserted directly rather than inferred from the
  // index definition: the moment the migration finishes, an archived address is free again.
  it("frees an archived address for reuse the moment it finishes", () => {
    const database = openRouterDatabase(writeVersion5Database({ populated: true }));
    try {
      const insert = database.prepare("INSERT INTO lane(id,address,project,role_description,created_at,updated_at) VALUES(?,?,?,?,?,?)");
      expect(() => insert.run("lane-new", "alpha/gone", "alpha", "gone again", 20, 20)).not.toThrow();
      // But only one of them may be alive: two live lanes at one address is what the address
      // still has to guarantee, and it is the half a plain non-unique column would lose.
      expect(() => insert.run("lane-dup", "alpha/here", "alpha", "clash", 20, 20)).toThrow(/constraint/iu);
    } finally { database.close(); }
  });

  it("migrates an empty version 5 database too", () => {
    const database = openRouterDatabase(writeVersion5Database({ populated: false }));
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(ROUTER_SCHEMA_VERSION);
      expect(database.prepare("SELECT COUNT(*) AS n FROM lane").get()).toEqual({ n: 0 });
      expect((database.pragma("table_info(lane)") as Array<{ name: string }>).map((column) => column.name)).toContain("id");
    } finally { database.close(); }
  });

  it("walks a version 1 database all the way to the current shape", () => {
    const database = openRouterDatabase(writeVersion1Database());
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(ROUTER_SCHEMA_VERSION);
      expect(database.prepare("SELECT COUNT(*) AS n FROM message").get()).toEqual({ n: 3 });
      expect(database.prepare("SELECT notification_state FROM message WHERE id='m-notified'").get())
        .toEqual({ notification_state: "sent" });
    } finally { database.close(); }
  });
});

const SENDER_CHECK = "CHECK ((sender_lane_id IS NULL) <> (sender_label IS NULL))";

function tableSql(database: Database.Database, table: string): string {
  return (database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql;
}

const TABLES_BEFORE_SETS = ["lane", "binding", "message", "message_archive"] as const;

function rowCounts(database: Database.Database, tables: readonly string[] = TABLES_BEFORE_SETS): Record<string, number> {
  return Object.fromEntries(tables.map((table) =>
    [table, (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]));
}

/**
 * A database in one of the shapes it can be in from version 6 on, with something in every table:
 * every step from here rebuilds a table, and an empty fixture would let "rebuild and lose the rows"
 * pass. Mail in both states, an archived message, and — where the shape has the column — mail sent
 * from outside every lane, so a step that wrongly runs again would have a labelled row to break on.
 */
function writeStartingShape(shape: (typeof STARTING_SHAPES)[StartingShape]): string {
  const root = mkdtempSync(join(tmpdir(), "lane-router-migration-"));
  roots.push(root);
  const path = join(root, "router.sqlite");
  const database = new Database(path);
  database.exec(schemaSql(shape));
  database.pragma(`user_version = ${shape.version}`);
  const lane = database.prepare("INSERT INTO lane(id,address,project,role_description,created_at,updated_at,archived_at) VALUES(?,?,?,?,1,1,?)");
  lane.run("lane-a", "alpha/a", "alpha", "a", null);
  lane.run("lane-b", "alpha/b", "alpha", "b", null);
  lane.run("lane-gone", "alpha/gone", "alpha", "gone", 900);
  const binding = database.prepare("INSERT INTO binding(id,lane_id,backend,conversation_id,generation,startup_json,active_at,inactive_at,cwd) VALUES(?,?,?,?,?,'{}',?,?,?)");
  binding.run("binding-1", "lane-a", "claude", "session-a", 7, 2, null, "E:\\alpha");
  if (shape.bindingBackends !== BINDING_BACKENDS.v6) binding.run("binding-2", "lane-b", "dsh", "host-session", 3, 4, 5, null);
  const message = database.prepare(`
    INSERT INTO message(id,request_key,sender_lane_id,target_lane_id,kind,reply_to,relative_path,
      content_sha256,state,created_at,resolved_at,ack_lane_id,ack_generation,notification_state)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  message.run("m-pending", "req-1", "lane-a", "lane-b", "normal", null, "p/1.md", SHA, "pending", 10, null, null, null, "sent");
  message.run("m-resolved", "req-2", "lane-b", "lane-a", "correction", "m-pending", "r/2.md", SHA, "resolved", 11, 12, "lane-a", 1, "sent");
  database.prepare(`
    INSERT INTO message_archive(id,request_key,sender_lane_id,target_lane_id,kind,reply_to,relative_path,
      content_sha256,state,created_at,resolved_at,ack_lane_id,ack_generation,notification_state,archived_at)
    VALUES('m-archived','req-3','lane-a','lane-gone','normal',NULL,'archive/lane-gone/3.md',?,'resolved',5,6,'lane-gone',1,'sent',900)
  `).run(SHA);
  if (shape.senderLabel) {
    database.prepare(`
      INSERT INTO message(id,request_key,sender_lane_id,sender_label,target_lane_id,kind,reply_to,relative_path,
        content_sha256,state,created_at,resolved_at,ack_lane_id,ack_generation,notification_state)
      VALUES('m-told','tell:m-told',NULL,'user:vikunja','lane-a','normal',NULL,'p/told.md',?,'pending',13,NULL,NULL,NULL,'sent')
    `).run(SHA);
    database.prepare(`
      INSERT INTO message_archive(id,request_key,sender_lane_id,sender_label,target_lane_id,kind,reply_to,relative_path,
        content_sha256,state,created_at,resolved_at,ack_lane_id,ack_generation,notification_state,archived_at)
      VALUES('a-told','tell:a-told',NULL,'user:vikunja','lane-gone','normal',NULL,'archive/lane-gone/told.md',?,'resolved',7,8,'lane-gone',1,'sent',900)
    `).run(SHA);
  }
  if (shape.laneSets) {
    database.prepare("INSERT INTO lane_set(id,name,created_at,updated_at) VALUES('set-1','research',20,21)").run();
    database.prepare("INSERT INTO lane_set_member(lane_id,set_id,added_at) VALUES('lane-a','set-1',22)").run();
  }
  database.close();
  return path;
}

describe("router schema from version 6 on", () => {
  // The six shapes a database can be in from version 6 on. Two of them are stamped 7 and mean
  // different things, which is why the steps are decided by shape: decided by number, the tell
  // database would be read as "DSH done", skip the binding rebuild, and then add a column it has.
  for (const [name, shape] of Object.entries(STARTING_SHAPES)) {
    it(`brings a ${name} database to the current shape without losing or changing a row`, () => {
      const path = writeStartingShape(shape);
      const raw = new Database(path, { readonly: true });
      const before = rowCounts(raw);
      raw.close();

      const database = openRouterDatabase(path);
      try {
        expect(database.pragma("user_version", { simple: true })).toBe(ROUTER_SCHEMA_VERSION);
        expect(tableSql(database, "binding")).toContain("backend IN ('claude','codex','dsh','zcode')");
        for (const table of ["message", "message_archive"]) {
          expect((database.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name), table).toContain("sender_label");
          expect(tableSql(database, table), table).toContain(SENDER_CHECK);
        }
        expect(rowCounts(database)).toEqual(before);

        // Present is not enough: a rebuild that copied the wrong column would keep every count.
        expect(database.prepare("SELECT id,backend,generation,cwd FROM binding ORDER BY id").all()).toEqual([
          { id: "binding-1", backend: "claude", generation: 7, cwd: "E:\\alpha" },
          ...(shape.bindingBackends === BINDING_BACKENDS.v6 ? [] : [{ id: "binding-2", backend: "dsh", generation: 3, cwd: null }]),
        ]);
        expect(database.prepare("SELECT id,sender_lane_id,sender_label FROM message ORDER BY id").all()).toEqual([
          { id: "m-pending", sender_lane_id: "lane-a", sender_label: null },
          { id: "m-resolved", sender_lane_id: "lane-b", sender_label: null },
          ...(shape.senderLabel ? [{ id: "m-told", sender_lane_id: null, sender_label: "user:vikunja" }] : []),
        ]);
        expect(database.prepare("SELECT id,sender_lane_id,sender_label FROM message_archive ORDER BY id").all()).toEqual([
          ...(shape.senderLabel ? [{ id: "a-told", sender_lane_id: null, sender_label: "user:vikunja" }] : []),
          { id: "m-archived", sender_lane_id: "lane-a", sender_label: null },
        ]);
        expect(database.prepare("SELECT reply_to,state,ack_lane_id,ack_generation FROM message WHERE id='m-resolved'").get())
          .toEqual({ reply_to: "m-pending", state: "resolved", ack_lane_id: "lane-a", ack_generation: 1 });
        // The set tables arrive empty, or keep exactly what a version 10 build put there.
        expect(database.prepare("SELECT id,name,created_at,updated_at FROM lane_set").all())
          .toEqual(shape.laneSets ? [{ id: "set-1", name: "research", created_at: 20, updated_at: 21 }] : []);
        expect(database.prepare("SELECT lane_id,set_id,added_at FROM lane_set_member").all())
          .toEqual(shape.laneSets ? [{ lane_id: "lane-a", set_id: "set-1", added_at: 22 }] : []);
        expect(database.pragma("foreign_key_check")).toEqual([]);
        expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
        for (const leftover of ["binding_legacy", "message_legacy", "message_archive_legacy"]) {
          expect(database.prepare("SELECT name FROM sqlite_master WHERE name=?").get(leftover), leftover).toBeUndefined();
        }
      } finally { database.close(); }
    });
  }

  it("leaves a version 10 database exactly as it was", () => {
    const path = writeStartingShape(STARTING_SHAPES.v10);
    const schemaOf = (database: Database.Database) => database.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
    const raw = new Database(path, { readonly: true });
    const before = { schema: schemaOf(raw), rows: rowCounts(raw, [...TABLES_BEFORE_SETS, "lane_set", "lane_set_member"]) };
    raw.close();
    const database = openRouterDatabase(path);
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(10);
      expect({ schema: schemaOf(database), rows: rowCounts(database, [...TABLES_BEFORE_SETS, "lane_set", "lane_set_member"]) }).toEqual(before);
    } finally { database.close(); }
  });

  // The set step is the third in the same transaction as the two rebuilds. Failing it must take
  // both of them back, or the next start would find a version 6 number on a version 9 shape.
  it("rolls the two earlier steps back when the lane set step fails", () => {
    const path = writeStartingShape(STARTING_SHAPES.v6);
    const database = new Database(path);
    database.pragma("foreign_keys = ON");
    const exec = database.exec.bind(database);
    vi.spyOn(database, "exec").mockImplementation((sql) => {
      if (sql.includes("CREATE TABLE lane_set")) throw new Error("injected lane set step failure");
      return exec(sql);
    });
    try {
      expect(() => initializeRouterSchema(database)).toThrow(/injected lane set step failure/);
      expect(database.pragma("user_version", { simple: true })).toBe(6);
      expect(tableSql(database, "binding")).toContain(`backend IN ${BINDING_BACKENDS.v6}`);
      expect((database.pragma("table_info(message)") as Array<{ name: string }>).map((column) => column.name)).not.toContain("sender_label");
      expect(rowCounts(database)).toEqual({ lane: 3, binding: 1, message: 2, message_archive: 1 });
      for (const leftover of ["lane_set", "lane_set_member", "binding_legacy", "message_legacy"]) {
        expect(database.prepare("SELECT name FROM sqlite_master WHERE name=?").get(leftover), leftover).toBeUndefined();
      }
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally { database.close(); }
  });

  // One transaction for every step: a failure in the last one must take the first one back too,
  // or the next start would find a database whose number says 6 and whose binding table says 8.
  it("rolls the binding step back when the message step fails", () => {
    const path = writeStartingShape(STARTING_SHAPES.v6);
    const database = new Database(path);
    database.pragma("foreign_keys = ON");
    const exec = database.exec.bind(database);
    vi.spyOn(database, "exec").mockImplementation((sql) => {
      if (sql.includes("RENAME TO message_legacy")) throw new Error("injected message step failure");
      return exec(sql);
    });
    try {
      expect(() => initializeRouterSchema(database)).toThrow(/injected message step failure/);
      expect(database.pragma("user_version", { simple: true })).toBe(6);
      expect(tableSql(database, "binding")).toContain(`backend IN ${BINDING_BACKENDS.v6}`);
      expect((database.pragma("table_info(message)") as Array<{ name: string }>).map((column) => column.name)).not.toContain("sender_label");
      expect(rowCounts(database)).toEqual({ lane: 3, binding: 1, message: 2, message_archive: 1 });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name='binding_legacy'").get()).toBeUndefined();
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally { database.close(); }
  });

  // The constraint is the whole of what keeps "sent by a lane" and "sent from outside" from
  // blurring: neither column alone says who sent a message, only the pair does. Both tables carry
  // it, because archiving copies a row from one to the other.
  it("allows exactly one kind of sender on a message, in both tables", () => {
    const database = openRouterDatabase(writeStartingShape(STARTING_SHAPES.v6));
    try {
      const live = database.prepare(`
        INSERT INTO message(id,request_key,sender_lane_id,sender_label,target_lane_id,kind,reply_to,relative_path,
          content_sha256,state,created_at,resolved_at,ack_lane_id,ack_generation,notification_state)
        VALUES(?,?,?,?,'lane-b','normal',NULL,?,?,'pending',20,NULL,NULL,NULL,'pending')
      `);
      expect(() => live.run("x-label", "req-x1", null, "user:vikunja", "p/x1.md", SHA)).not.toThrow();
      expect(() => live.run("x-lane", "req-x2", "lane-a", null, "p/x2.md", SHA)).not.toThrow();
      expect(() => live.run("x-neither", "req-x3", null, null, "p/x3.md", SHA)).toThrow(/constraint/iu);
      expect(() => live.run("x-both", "req-x4", "lane-a", "user:vikunja", "p/x4.md", SHA)).toThrow(/constraint/iu);

      const archived = database.prepare(`
        INSERT INTO message_archive(id,request_key,sender_lane_id,sender_label,target_lane_id,kind,reply_to,relative_path,
          content_sha256,state,created_at,resolved_at,ack_lane_id,ack_generation,notification_state,archived_at)
        VALUES(?,?,?,?,'lane-gone','normal',NULL,?,?,'resolved',1,2,'lane-gone',1,'sent',900)
      `);
      expect(() => archived.run("a-label", "req-a1", null, "user:vikunja", "a/1.md", SHA)).not.toThrow();
      expect(() => archived.run("a-neither", "req-a2", null, null, "a/2.md", SHA)).toThrow(/constraint/iu);
      expect(() => archived.run("a-both", "req-a3", "lane-a", "user:vikunja", "a/3.md", SHA)).toThrow(/constraint/iu);
    } finally { database.close(); }
  });

  it("migrates an empty version 6 database too", () => {
    const root = mkdtempSync(join(tmpdir(), "lane-router-migration-"));
    roots.push(root);
    const path = join(root, "router.sqlite");
    const raw = new Database(path);
    raw.exec(SCHEMA_V6_SQL);
    raw.pragma("user_version = 6");
    raw.close();
    const database = openRouterDatabase(path);
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(ROUTER_SCHEMA_VERSION);
      const columns = (database.pragma("table_info(message)") as Array<{ name: string; notnull: number }>);
      expect(columns.find((column) => column.name === "sender_label")).toMatchObject({ notnull: 0 });
      expect(columns.find((column) => column.name === "sender_lane_id")).toMatchObject({ notnull: 0 });
      expect(tableSql(database, "binding")).toContain("'zcode'");
      expect(rowCounts(database, ["lane_set", "lane_set_member"])).toEqual({ lane_set: 0, lane_set_member: 0 });
    } finally { database.close(); }
  });
});

describe("lane set tables", () => {
  function freshDatabasePath(): string {
    const root = mkdtempSync(join(tmpdir(), "lane-router-migration-"));
    roots.push(root);
    return join(root, "router.sqlite");
  }

  it("builds a new database straight to version 10 with both tables", () => {
    const database = openRouterDatabase(freshDatabasePath());
    try {
      expect(ROUTER_SCHEMA_VERSION).toBe(10);
      expect(database.pragma("user_version", { simple: true })).toBe(10);
      expect(rowCounts(database, ["lane_set", "lane_set_member"])).toEqual({ lane_set: 0, lane_set_member: 0 });
    } finally { database.close(); }
  });

  // Checked on both ways a database gets the tables, because they are two pieces of code: the
  // migration from a live version 9 database, and the schema a new database is created with.
  const origins: ReadonlyArray<readonly [string, () => string]> = [
    ["a version 9 database after migrating", () => writeStartingShape(STARTING_SHAPES.v9)],
    ["a new database", () => {
      const path = freshDatabasePath();
      const database = openRouterDatabase(path);
      const lane = database.prepare("INSERT INTO lane(id,address,project,role_description,created_at,updated_at,archived_at) VALUES(?,?,?,?,1,1,NULL)");
      for (const id of ["lane-a", "lane-b"]) lane.run(id, `alpha/${id}`, "alpha", id);
      database.close();
      return path;
    }],
  ];
  for (const [origin, makePath] of origins) {
    it(`keeps a lane in at most one set and a set's members with it, in ${origin}`, () => {
      const database = openRouterDatabase(makePath());
      try {
        const set = database.prepare("INSERT INTO lane_set(id,name,created_at,updated_at) VALUES(?,?,1,1)");
        const member = database.prepare("INSERT INTO lane_set_member(lane_id,set_id,added_at) VALUES(?,?,1)");
        set.run("set-1", "research");
        set.run("set-2", "curvenet");
        expect(() => set.run("set-3", "research")).toThrow(/constraint/iu);
        expect(() => set.run("set-4", "   ")).toThrow(/constraint/iu);

        member.run("lane-a", "set-1");
        expect(() => member.run("lane-a", "set-2")).toThrow(/constraint/iu);
        expect(() => member.run("lane-b", "no-such-set")).toThrow(/constraint/iu);
        expect(() => member.run("no-such-lane", "set-2")).toThrow(/constraint/iu);

        // A lane is never deleted, and a membership must not become the way one could be.
        database.prepare("INSERT INTO lane(id,address,project,role_description,created_at,updated_at) VALUES('lane-x','beta/x','beta','x',1,1)").run();
        member.run("lane-x", "set-2");
        expect(() => database.prepare("DELETE FROM lane WHERE id='lane-x'").run()).toThrow(/constraint/iu);

        database.prepare("DELETE FROM lane_set WHERE id='set-1'").run();
        expect(database.prepare("SELECT lane_id,set_id FROM lane_set_member ORDER BY lane_id").all())
          .toEqual([{ lane_id: "lane-x", set_id: "set-2" }]);
        expect(database.prepare("SELECT COUNT(*) AS n FROM lane WHERE id='lane-a'").get()).toEqual({ n: 1 });
      } finally { database.close(); }
    });
  }
});
