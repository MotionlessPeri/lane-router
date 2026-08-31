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
      expect(database.pragma("user_version", { simple: true })).toBe(6);

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
      expect(database.pragma("user_version", { simple: true })).toBe(6);
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
      expect(database.pragma("user_version", { simple: true })).toBe(6);
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
      expect(database.pragma("user_version", { simple: true })).toBe(6);
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
      expect(database.pragma("user_version", { simple: true })).toBe(6);
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
  // Every row in every rebuilt table, because a rebuild is the one migration shape that can lose
  // them silently: nothing downstream reads a count, so a dropped row would first be noticed as a
  // lane whose history had simply gone.
  it("rebuilds all three tables without losing a row", () => {
    const database = openRouterDatabase(writeVersion5Database({ populated: true }));
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(6);
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
      expect(database.pragma("user_version", { simple: true })).toBe(6);
      expect(database.prepare("SELECT COUNT(*) AS n FROM lane").get()).toEqual({ n: 0 });
      expect((database.pragma("table_info(lane)") as Array<{ name: string }>).map((column) => column.name)).toContain("id");
    } finally { database.close(); }
  });

  it("walks a version 1 database all the way to the current shape", () => {
    const database = openRouterDatabase(writeVersion1Database());
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(6);
      expect(database.prepare("SELECT COUNT(*) AS n FROM message").get()).toEqual({ n: 3 });
      expect(database.prepare("SELECT notification_state FROM message WHERE id='m-notified'").get())
        .toEqual({ notification_state: "sent" });
    } finally { database.close(); }
  });
});
