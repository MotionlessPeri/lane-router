import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { initializeRouterSchema, ROUTER_SCHEMA_VERSION } from "../../src/router/schema.js";
import { schemaSql, STARTING_SHAPES } from "../fixtures/router/schema-shapes.js";

const databases: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(db => db.close()); });
function fixture(kind: string, transform: (sql: string) => string = sql => sql) {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(transform(readFileSync(new URL(`../fixtures/schema/v8-${kind}.sql`, import.meta.url), "utf8")));
  db.pragma("foreign_keys = ON");
  for (const [i, backend] of ["claude", "codex", "dsh", kind === "native" ? "native-codex" : "zcode"].entries()) {
    db.prepare("INSERT INTO lane VALUES(?,?,?,?,?,?,?,?)").run(`lane-${i}`, `test/lane-${i}`, "test", "role", 1, 2, `model-${i}`, i === 3 ? 3 : null);
    db.prepare("INSERT INTO binding VALUES(?,?,?,?,?,?,?,?,?)").run(`b-${i}`, `lane-${i}`, backend, `thread-${i}`, i + 1, '{ "raw": true }', 4, i === 3 ? 5 : null, "D:/fixture");
  }
  const sha = "a".repeat(64);
  db.prepare("INSERT INTO message VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("pending", "request-p", "lane-0", "lane-1", "normal", null, "pending/p.md", sha, "pending", 6, null, null, null, "deferred");
  db.prepare("INSERT INTO message VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("resolved", "request-r", "lane-1", "lane-0", "correction", "pending", "resolved/r.md", sha, "resolved", 7, 8, "lane-0", 4, "sent");
  db.prepare("INSERT INTO message_archive VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("archived", "request-a", "lane-3", "lane-0", "normal", null, "archive/a.md", sha, "resolved", 9, 10, "lane-0", 4, "sent", 11);
  return db;
}
function rows(db: Database.Database) {
  return Object.fromEntries(["lane", "binding", "message", "message_archive"].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => table.startsWith("message") ? { sender_label: null, ...(row as object) } : row)]));
}
function insertNew(db: Database.Database, backend: string) {
  db.prepare("INSERT INTO binding VALUES(?,?,?,?,?,?,?,?,?)").run(`new-${backend}`, "lane-3", backend, backend, 10 + (backend === "zcode" ? 1 : 2), "{}", 20, 21, null);
}
test.each(["zcode", "native"])("v8 %s migrates without changing any record and admits both backends", kind => {
  const db = fixture(kind), before = rows(db);
  initializeRouterSchema(db);
  expect(rows(db)).toEqual(before);
  expect(() => insertNew(db, "zcode")).not.toThrow();
  expect(() => insertNew(db, "native-codex")).not.toThrow();
  expect(db.pragma("user_version", { simple: true })).toBe(ROUTER_SCHEMA_VERSION);
  initializeRouterSchema(db);
  expect(db.pragma("foreign_key_check")).toEqual([]);
  expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
});
test.each([8, 9])("version %i with an unknown shape is refused without mutation", version => {
  const db = fixture("zcode");
  db.exec("DROP INDEX binding_active_lane_idx; CREATE INDEX binding_active_lane_idx ON binding(lane_id)");
  db.pragma(`user_version=${version}`);
  const before = rows(db);
  expect(() => initializeRouterSchema(db)).toThrow(/shape|schema/i);
  expect(rows(db)).toEqual(before);
  expect(db.pragma("user_version", { simple: true })).toBe(version);
});
test("copy interruption rolls back every record, schema version and foreign key setting", () => {
  const db = fixture("zcode"), before = rows(db), original = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation(sql => { if (/INSERT INTO binding\(/.test(sql)) throw new Error("fixture-copy-interruption"); return original(sql); });
  expect(() => initializeRouterSchema(db)).toThrow("fixture-copy-interruption");
  expect(rows(db)).toEqual(before);
  expect(db.pragma("user_version", { simple: true })).toBe(8);
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
});
test("dangling references are rejected before any migration", () => {
  const db = fixture("native"); db.pragma("foreign_keys=OFF");
  db.exec("UPDATE binding SET lane_id='missing' WHERE id='b-0'");
  const before = rows(db);
  expect(() => initializeRouterSchema(db)).toThrow(/dangling/);
  expect(rows(db)).toEqual(before);
  expect(db.pragma("user_version", { simple: true })).toBe(8);
  expect(db.pragma("foreign_keys", { simple: true })).toBe(0);
});

test("a duplicate introduced during copy is rolled back with the old indexes", () => {
  const db = fixture("native"), before = rows(db), original = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation(sql => {
    if (/INSERT INTO binding\(/.test(sql)) original("INSERT INTO binding_legacy SELECT 'duplicate',lane_id,backend,conversation_id,generation,startup_json,active_at,inactive_at,cwd FROM binding_legacy WHERE id='b-0'");
    return original(sql);
  });
  expect(() => initializeRouterSchema(db)).toThrow(/UNIQUE/);
  expect(rows(db)).toEqual(before);
  expect(db.pragma("user_version", { simple: true })).toBe(8);
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  vi.restoreAllMocks();
  initializeRouterSchema(db);
  expect(rows(db)).toEqual(before);
});

test("record corruption during copy cannot be committed", () => {
  const db = fixture("zcode"), before = rows(db), original = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation(sql => {
    const result = original(sql);
    if (/INSERT INTO binding\(/.test(sql)) original("UPDATE binding SET cwd='corrupted' WHERE id='b-0'");
    return result;
  });
  expect(() => initializeRouterSchema(db)).toThrow("Router database migration changed records");
  expect(rows(db)).toEqual(before);
  expect(db.pragma("user_version", { simple: true })).toBe(8);
});

test("foreign key failure inside the transaction rolls back schema and data", () => {
  const db = fixture("native"), before = rows(db), original = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation(sql => {
    const result = original(sql);
    if (sql === "DROP TABLE binding_legacy;") original("UPDATE binding SET lane_id='missing' WHERE id='b-0'");
    return result;
  });
  expect(() => initializeRouterSchema(db)).toThrow(/dangling/);
  expect(rows(db)).toEqual(before);
  expect(db.pragma("user_version", { simple: true })).toBe(8);
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
});

test("SQL whitespace changes do not change the accepted historical shape", () => {
  const db = fixture("native", sql => sql.replace(/\n/g, "\n\t "));
  const before = rows(db); initializeRouterSchema(db);
  expect(rows(db)).toEqual(before);
});

test("an unrecognized backend CHECK vocabulary is rejected before writes", () => {
  const db = fixture("zcode", sql => sql.replace("'dsh','zcode'", "'dsh','zcode','unknown'"));
  const before = rows(db);
  expect(() => initializeRouterSchema(db)).toThrow(/schema shape/);
  expect(rows(db)).toEqual(before);
  expect(db.pragma("user_version", { simple: true })).toBe(8);
});

test.each([false, true])("version 10 with native=%s preserves bindings, sender labels and populated lane sets", native => {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(schemaSql(STARTING_SHAPES.v10).replace("'dsh','zcode'", native ? "'dsh','zcode','native-codex'" : "'dsh','zcode'"));
  db.pragma("user_version=10");
  db.exec("INSERT INTO lane VALUES('lead','company/lead','company','lead',1,2,'model',NULL)");
  db.prepare("INSERT INTO binding VALUES('shared','lead',?,'host-and-thread',7,'{}',3,NULL,'D:/company')").run(native ? "native-codex" : "codex");
  db.exec("INSERT INTO lane_set VALUES('set','company',4,4); INSERT INTO lane_set_member VALUES('lead','set',5)");
  db.prepare("INSERT INTO message(id,request_key,sender_label,target_lane_id,kind,relative_path,content_sha256,created_at) VALUES('note','request','user:operator','lead','normal','pending/note.md',?,6)").run("a".repeat(64));
  const before = rows(db);
  const members = db.prepare("SELECT * FROM lane_set_member").all();
  initializeRouterSchema(db);
  expect(rows(db)).toEqual(before);
  expect(db.prepare("SELECT * FROM lane_set_member").all()).toEqual(members);
  expect(db.prepare("SELECT * FROM lane_set").all()).toEqual([{ id: "set", name: "company", created_at: 4, updated_at: 4 }]);
  expect(() => db.prepare("INSERT INTO binding VALUES('next','lead','native-codex','next-host',8,'{}',7,8,NULL)").run()).not.toThrow();
  initializeRouterSchema(db);
  expect(db.pragma("user_version", { simple: true })).toBe(11);
  expect(db.pragma("foreign_key_check")).toEqual([]);
});

test("a version 11 stamp cannot make the old backend constraint current", () => {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(schemaSql(STARTING_SHAPES.v10));
  db.pragma("user_version=11");
  expect(() => initializeRouterSchema(db)).toThrow(/schema shape/);
  expect(db.pragma("user_version", { simple: true })).toBe(11);
});
