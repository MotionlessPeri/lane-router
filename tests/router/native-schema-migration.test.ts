import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { initializeRouterSchema } from "../../src/router/schema.js";

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
  return Object.fromEntries(["lane", "binding", "message", "message_archive"].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
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
  expect(db.pragma("user_version", { simple: true })).toBe(9);
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
