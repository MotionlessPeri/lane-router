import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import { ISSUE_SCHEMA_VERSION, openIssueStore } from "../../../src/modules/issues/index.js";

// Spec 2026-10-20-issue-lane-close-and-default-publish.md, acceptance 5, and 2026-10-20-issue-files.md,
// acceptance 6: older databases become the current version in place after a backup. The fixtures
// are each version as it shipped, frozen in files, not rebuilt from the code under test: v1's
// schema, and the statements that made v2 out of it. v1 ran its SQL from a template literal, whose
// line ends are always LF, so the files are read that way whatever line ends a checkout gave them;
// the SQL SQLite keeps is then the same text a real database of that version holds.
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/issues/${name}`, import.meta.url), "utf8").replace(/\r\n/gu, "\n");
const V1 = fixture("v1-schema.sql");
const V2_FROM_V1 = fixture("v2-from-v1.sql");
// Spec 2026-10-21-issue-attachment-order.md, acceptance 1: v3's statements as they shipped.
const V3_FROM_V2 = fixture("v3-from-v2.sql");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A v2 database as the Router left it: the v1 one below, as v2's upgrade made it. */
function v2Database(alter?: string) {
  const v1 = v1Database(`${V2_FROM_V1}\n${alter ?? ""}`);
  return { ...v1, backup: `${v1.path}.v2.bak` };
}

/** A v3 database as the Router left it: the v2 one with a file a reply took, and one still waiting. */
function v3Database(alter?: string) {
  const v1 = v1Database(`${V2_FROM_V1}\n${V3_FROM_V2}
    INSERT INTO issue_attachment VALUES('file-taken','open-1','e2','plan.md','application/octet-stream',5,'${"a".repeat(64)}','C:/files/plan.md',3);
    INSERT INTO issue_attachment VALUES('file-waiting',NULL,NULL,'shot.png','image/png',9,'${"b".repeat(64)}','C:/files/shot.png',8);
    ${alter ?? ""}`);
  return { ...v1, backup: `${v1.path}.v3.bak` };
}
/** Every attachment row, with or without the column v4 adds. */
function attachmentRows(path: string) {
  const database = new Database(path, { readonly: true });
  try { return database.prepare("SELECT * FROM issue_attachment ORDER BY id").all() as Record<string, unknown>[]; } finally { database.close(); }
}

/** A v1 database as the Router left it: one issue open and waiting on its lane, one the user ended. */
function v1Database(alter?: string) {
  const root = mkdtempSync(join(tmpdir(), "lane-issues-v1-")); roots.push(root);
  const path = join(root, "issues.sqlite");
  const database = new Database(path);
  database.exec(V1);
  database.exec(`
    INSERT INTO issue_thread VALUES('open-1','lane-one','Open one','question','open',1,4,NULL,0,3);
    INSERT INTO issue_thread VALUES('closed-1','lane-one','Closed one','question','closed',5,7,7,2,3);
    INSERT INTO issue_entry VALUES('e1','open-1',1,'question','lane','agent','Which?',NULL,'binding:lane-one',1,2);
    INSERT INTO issue_entry VALUES('e2','open-1',2,'reply','user','user_page','A','e1',NULL,NULL,3);
    INSERT INTO issue_question VALUES('q1','open-1','e1','user','waiting_lane',NULL,NULL);
    INSERT INTO issue_delivery VALUES('d1','open-1','e2','lane-one','用户已在议题页面回复','user','issues','issues:d1','accepted','m1',1,3,NULL,'active',NULL,NULL,NULL,3);
    INSERT INTO issue_entry VALUES('e3','closed-1',1,'question','lane','agent','Done?',NULL,'binding:lane-one',1,6);
    INSERT INTO issue_entry VALUES('e4','closed-1',2,'event','user','user_page','用户在议题页面明确确认结束讨论。',NULL,NULL,NULL,7);
    INSERT INTO issue_question VALUES('q2','closed-1','e3','user','waiting_user',NULL,NULL);
    INSERT INTO issue_operation VALUES('user:local','close','close-key','${"0".repeat(64)}','{}',7);
  `);
  if (alter) database.exec(alter);
  database.close();
  return { root, path, backup: `${path}.v1.bak` };
}

const TABLES = ["issue_delivery", "issue_entry", "issue_operation", "issue_question", "issue_thread"];
/** Every row of the tables v1 had; without the column v2 adds unless asked, so v1 rows compare directly. */
function rows(path: string, closedBy = false) {
  const database = new Database(path, { readonly: true });
  try {
    return Object.fromEntries(TABLES.map(table => [table, (database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[])
      .map(({ closed_by, ...row }) => closedBy && table === "issue_thread" ? { ...row, closed_by } : row)]));
  } finally { database.close(); }
}
function facts(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    const has = (table: string, column?: string) => Boolean(column
      ? database.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name=?").get(table, column)
      : database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    return {
      version: (database.prepare("SELECT version FROM issue_schema_version").get() as { version: number }).version,
      closedBy: has("issue_thread", "closed_by") ? database.prepare("SELECT id,status,closed_by AS closedBy FROM issue_thread ORDER BY id").all() : null,
      attachments: has("issue_attachment") ? database.prepare("SELECT count(*) AS count FROM issue_attachment").get() : null,
      foreignKeys: database.pragma("foreign_key_check"),
      schema: database.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),
    };
  } finally { database.close(); }
}

test("the current version is 4", () => {
  expect(ISSUE_SCHEMA_VERSION).toBe(4);
});

test("a v3 database is backed up as v3 alone, then upgraded in place with every row kept and no position on its files", () => {
  const { path, backup } = v3Database();
  const before = rows(path, true), files = attachmentRows(path);
  expect(facts(path)).toMatchObject({ version: 3, attachments: { count: 2 } });
  openIssueStore(path).close();
  expect(facts(path)).toMatchObject({ version: ISSUE_SCHEMA_VERSION, attachments: { count: 2 }, foreignKeys: [] });
  expect(rows(path, true)).toEqual(before);
  expect(attachmentRows(path)).toEqual(files.map(row => ({ ...row, position: null })));
  expect(facts(backup)).toMatchObject({ version: 3, attachments: { count: 2 } });
  expect(attachmentRows(backup)).toEqual(files);
  for (const other of [1, 2]) expect(existsSync(`${path}.v${other}.bak`), `v${other}`).toBe(false);
});

test("a v1 database is backed up, then upgraded in place to the current version with every row kept and its ended issues ended by the user", () => {
  const { path, backup } = v1Database();
  const before = rows(path);
  const store = openIssueStore(path);
  try {
    expect(store.thread("closed-1")).toMatchObject({ status: "closed", closedAt: 7, closedBy: "user" });
    expect(store.thread("open-1")).toMatchObject({ status: "open", closedAt: null, closedBy: null });
  } finally { store.close(); }

  const upgraded = facts(path);
  expect(upgraded.version).toBe(ISSUE_SCHEMA_VERSION);
  expect(upgraded.closedBy).toEqual([{ id: "closed-1", status: "closed", closedBy: "user" }, { id: "open-1", status: "open", closedBy: null }]);
  expect(upgraded.attachments).toEqual({ count: 0 });
  expect(upgraded.foreignKeys).toEqual([]);
  expect(rows(path)).toEqual(before);

  expect(existsSync(backup)).toBe(true);
  const kept = facts(backup);
  expect(kept.version).toBe(1);
  expect(kept.closedBy).toBeNull();
  expect(kept.attachments).toBeNull();
  expect(rows(backup)).toEqual(before);
  // One step to the current version, so one backup: none for the versions passed through.
  for (const other of [2, 3]) expect(existsSync(`${path}.v${other}.bak`), `v${other}`).toBe(false);
});

test("a v2 database is backed up as v2, then upgraded in place to the current version with every row kept", () => {
  const { path, backup } = v2Database();
  const before = rows(path, true);
  expect(facts(path)).toMatchObject({ version: 2, attachments: null });
  openIssueStore(path).close();
  expect(facts(path)).toMatchObject({ version: ISSUE_SCHEMA_VERSION, attachments: { count: 0 }, foreignKeys: [] });
  expect(rows(path, true)).toEqual(before);
  expect(facts(backup)).toMatchObject({ version: 2, attachments: null });
  expect(rows(backup, true)).toEqual(before);
  expect(existsSync(`${path}.v1.bak`)).toBe(false);
});

test("an upgraded database opened again is not upgraded again, and its backup is neither replaced nor made anew", () => {
  for (const made of [v1Database, v2Database, v3Database]) {
    const { path, backup } = made();
    openIssueStore(path).close();
    const kept = hash(backup), upgraded = facts(path);
    openIssueStore(path).close();
    expect(hash(backup), made.name).toBe(kept);
    expect(facts(path), made.name).toEqual(upgraded);
    rmSync(backup);
    openIssueStore(path).close();
    expect(existsSync(backup), made.name).toBe(false);
  }
});

test("a fresh database is the current version and has exactly the structure an upgraded one has, from v1, v2 or v3", () => {
  const fresh = join(v1Database().root, "fresh.sqlite");
  openIssueStore(fresh).close();
  expect(facts(fresh).version).toBe(ISSUE_SCHEMA_VERSION);
  for (const made of [v1Database, v2Database, v3Database]) {
    const { path } = made();
    openIssueStore(path).close();
    expect(facts(fresh).schema, made.name).toEqual(facts(path).schema);
  }
});

test("an altered older database and an unknown version are refused untouched, with no backup", () => {
  for (const [made, alter] of [
    [v1Database, "DROP INDEX issue_question_status_idx"], [v1Database, "UPDATE issue_schema_version SET version=99"],
    [v2Database, "DROP INDEX issue_question_status_idx"], [v2Database, "UPDATE issue_schema_version SET version=99"],
    [v3Database, "DROP INDEX issue_attachment_unattached_idx"], [v3Database, "UPDATE issue_schema_version SET version=99"],
    // v1's structure claiming to be v2 is not v2, and v2's claiming to be v3 is not v3.
    [v1Database, "UPDATE issue_schema_version SET version=2"],
    [v2Database, "UPDATE issue_schema_version SET version=3"],
  ] as const) {
    const { path, backup } = made(alter);
    const original = hash(path);
    expect(() => openIssueStore(path).close(), `${made.name} ${alter}`).toThrow();
    expect(hash(path), alter).toBe(original);
    expect(existsSync(backup), alter).toBe(false);
    for (const other of [1, 2, 3]) expect(existsSync(`${path}.v${other}.bak`), `${alter} v${other}`).toBe(false);
  }
});

test("a backup that cannot be written stops the upgrade before it starts, and the store does not open", () => {
  const { path, backup } = v1Database();
  // A directory where the backup goes: not a backup that may be kept, and not one that can be written.
  mkdirSync(backup);
  const original = hash(path);
  expect(() => openIssueStore(path).close()).toThrow();
  expect(hash(path)).toBe(original);
  expect(facts(path).version).toBe(1);
});
