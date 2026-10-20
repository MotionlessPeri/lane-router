import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import { openIssueStore } from "../../../src/modules/issues/index.js";

// Spec 2026-10-20-issue-lane-close-and-default-publish.md, acceptance 5: v1 databases become v2 in
// place after a backup. The v1 fixture is the schema as v1 shipped, frozen in a file, not rebuilt
// from the code under test.
const V1 = readFileSync(new URL("../../fixtures/issues/v1-schema.sql", import.meta.url), "utf8");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

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
/** Every row of every table, without the column v2 adds, so v1 and v2 rows compare directly. */
function rows(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    return Object.fromEntries(TABLES.map(table => [table, (database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[])
      .map(({ closed_by: _closedBy, ...row }) => row)]));
  } finally { database.close(); }
}
function facts(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    return {
      version: (database.prepare("SELECT version FROM issue_schema_version").get() as { version: number }).version,
      closedBy: database.prepare("SELECT name FROM pragma_table_info('issue_thread') WHERE name='closed_by'").get()
        ? database.prepare("SELECT id,status,closed_by AS closedBy FROM issue_thread ORDER BY id").all() : null,
      foreignKeys: database.pragma("foreign_key_check"),
      schema: database.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),
    };
  } finally { database.close(); }
}

test("a v1 database is backed up, then upgraded in place to v2 with every row kept and its ended issues ended by the user", () => {
  const { path, backup } = v1Database();
  const before = rows(path);
  const store = openIssueStore(path);
  try {
    expect(store.thread("closed-1")).toMatchObject({ status: "closed", closedAt: 7, closedBy: "user" });
    expect(store.thread("open-1")).toMatchObject({ status: "open", closedAt: null, closedBy: null });
  } finally { store.close(); }

  const upgraded = facts(path);
  expect(upgraded.version).toBe(2);
  expect(upgraded.closedBy).toEqual([{ id: "closed-1", status: "closed", closedBy: "user" }, { id: "open-1", status: "open", closedBy: null }]);
  expect(upgraded.foreignKeys).toEqual([]);
  expect(rows(path)).toEqual(before);

  expect(existsSync(backup)).toBe(true);
  const kept = facts(backup);
  expect(kept.version).toBe(1);
  expect(kept.closedBy).toBeNull();
  expect(rows(backup)).toEqual(before);
});

test("a v2 database opened again is not upgraded again, and its backup is neither replaced nor made anew", () => {
  const { path, backup } = v1Database();
  openIssueStore(path).close();
  const kept = hash(backup), upgraded = facts(path);
  openIssueStore(path).close();
  expect(hash(backup)).toBe(kept);
  expect(facts(path)).toEqual(upgraded);
  rmSync(backup);
  openIssueStore(path).close();
  expect(existsSync(backup)).toBe(false);
});

test("a fresh database is v2 and has exactly the structure an upgraded one has", () => {
  const { path } = v1Database();
  openIssueStore(path).close();
  const fresh = join(roots[0]!, "fresh.sqlite");
  openIssueStore(fresh).close();
  expect(facts(fresh).version).toBe(2);
  expect(facts(fresh).schema).toEqual(facts(path).schema);
});

test("an altered v1 database and an unknown version are refused untouched, with no backup", () => {
  for (const alter of ["DROP INDEX issue_question_status_idx", "UPDATE issue_schema_version SET version=3", "UPDATE issue_schema_version SET version=99"]) {
    const { path, backup } = v1Database(alter);
    const original = hash(path);
    expect(() => openIssueStore(path).close(), alter).toThrow();
    expect(hash(path), alter).toBe(original);
    expect(existsSync(backup), alter).toBe(false);
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
