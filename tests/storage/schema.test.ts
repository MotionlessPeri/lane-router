import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/storage/database.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "lane-router-schema-"));
  temporaryDirectories.push(directory);
  return join(directory, "router.sqlite");
}

describe("SQLite schema", () => {
  it("creates the durable broker model with migration v1, foreign keys, and WAL", () => {
    const path = temporaryDatabasePath();
    const connection = openDatabase(path);

    expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(connection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(connection.pragma("user_version", { simple: true })).toBe(1);

    const tables = connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining([
      "project",
      "workspace",
      "workspace_relink",
      "lane",
      "binding",
      "message",
      "delivery",
      "claim",
      "ack",
      "operation",
      "event",
    ]));

    const persisted = new Database(path);
    try {
      expect(persisted.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(persisted.pragma("foreign_key_check")).toEqual([]);
    } finally {
      persisted.close();
    }

    connection.close();
    expect(() => connection.prepare("SELECT 1")).toThrow();
  });

  it("enforces durable identity, generation, state, and initial-delivery constraints", () => {
    const db = openDatabase(temporaryDatabasePath());
    try {
      db.prepare("INSERT INTO project VALUES (?, ?, ?, ?, ?, ?)").run(
        "project-1", "project-key", "Project", "manifest-1", 1, 1,
      );
      expect(() => db.prepare("INSERT INTO project VALUES (?, ?, ?, ?, ?, ?)").run(
        "project-2", "project-key", "Other", "manifest-2", 1, 1,
      )).toThrow();

      db.prepare("INSERT INTO workspace VALUES (?, ?, ?, ?, ?)").run(
        "workspace-1", "project-1", "C:/repo", 1, 1,
      );
      db.prepare("INSERT INTO lane VALUES (?, ?, ?, ?, ?)").run(
        "lane-1", "project-1", "communication", "docs/role.md", 1,
      );
      db.prepare("INSERT INTO binding VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "binding-1", "lane-1", "workspace-1", "codex", "thread-1", 1,
        1, null, null, 1,
      );
      expect(() => db.prepare("INSERT INTO binding VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "binding-2", "lane-1", "workspace-1", "codex", "thread-2", 2,
        2, null, null, 1,
      )).toThrow();
      expect(() => db.prepare("UPDATE binding SET generation = 0 WHERE id = 'binding-1'").run()).toThrow();

      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "message-1", "binding-1", "lane-1", "normal", "hello", "{}", null, 3,
      );
      db.prepare("INSERT INTO delivery VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "delivery-1", "message-1", "lane-1", 1, "pending", 0,
        null, null, null, null, null, null, null,
      );
      expect(() => db.prepare("INSERT INTO delivery VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "delivery-2", "message-1", "lane-1", 2, "pending", 0,
        null, null, null, null, null, null, null,
      )).toThrow();
      expect(() => db.prepare("UPDATE delivery SET state = 'invalid' WHERE id = 'delivery-1'").run()).toThrow();
      expect(() => db.prepare("DELETE FROM project WHERE id = 'project-1'").run()).toThrow();
    } finally {
      db.close();
    }
  });

  it("rejects generation rollback, immutable message edits, and state-incompatible deadlines", () => {
    const db = openDatabase(temporaryDatabasePath());
    try {
      db.prepare("INSERT INTO project VALUES (?, ?, ?, ?, ?, ?)").run(
        "project-1", "project-key", "Project", "manifest-1", 1, 1,
      );
      db.prepare("INSERT INTO workspace VALUES (?, ?, ?, ?, ?)").run(
        "workspace-1", "project-1", "C:/repo", 1, 1,
      );
      db.prepare("INSERT INTO lane VALUES (?, ?, ?, ?, ?)").run(
        "lane-1", "project-1", "communication", "docs/role.md", 1,
      );
      db.prepare("INSERT INTO binding VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "binding-2", "lane-1", "workspace-1", "codex", "thread-2", 2,
        1, 2, "rotated", 0,
      );
      expect(() => db.prepare("INSERT INTO binding VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "binding-1", "lane-1", "workspace-1", "codex", "thread-1", 1,
        3, null, null, 1,
      )).toThrow();

      db.prepare("INSERT INTO binding VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "binding-3", "lane-1", "workspace-1", "codex", "thread-3", 3,
        3, null, null, 1,
      );
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "message-1", "binding-3", "lane-1", "normal", "original", "{}", null, 4,
      );
      expect(() => db.prepare("UPDATE message SET body='changed' WHERE id='message-1'").run()).toThrow();
      expect(() => db.prepare(`
        INSERT INTO delivery VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "delivery-invalid", "message-1", "lane-1", 1, "pending", 0,
        "claim", 10, null, null, "started_new_turn", null, 5,
      )).toThrow();
    } finally {
      db.close();
    }
  });
});
