import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/storage/database.js";
import { seedStorage } from "../fixtures/storage/seed.js";

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
  it("upgrades an existing migration-v1 binding table to durable lifecycle state", () => {
    const path = temporaryDatabasePath();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE binding (
        id TEXT PRIMARY KEY,
        lane_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        adapter TEXT NOT NULL CHECK (adapter IN ('claude', 'codex')),
        conversation_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        active_at INTEGER NOT NULL,
        inactive_at INTEGER,
        inactive_reason TEXT,
        is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
        CHECK (
          (is_current = 1 AND inactive_at IS NULL AND inactive_reason IS NULL) OR
          (is_current = 0 AND inactive_at IS NOT NULL AND inactive_reason IS NOT NULL)
        ),
        UNIQUE(lane_id, generation)
      );
      INSERT INTO binding VALUES (
        'binding-legacy', 'lane-1', 'workspace-1', 'codex', 'thread-1',
        1, 1, NULL, NULL, 1
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const upgraded = openDatabase(path);
    try {
      expect(upgraded.pragma("user_version", { simple: true })).toBe(2);
      expect(upgraded.prepare(`
        SELECT state, state_changed_at, state_reason FROM binding WHERE id = 'binding-legacy'
      `).get()).toEqual({ state: "bound", state_changed_at: null, state_reason: null });
      expect(() => upgraded.prepare("UPDATE binding SET generation=10").run()).toThrow();
    } finally {
      upgraded.close();
    }
  });

  it("creates the durable broker model at migration v2 with foreign keys and WAL", () => {
    const path = temporaryDatabasePath();
    const connection = openDatabase(path);

    expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(connection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(connection.pragma("user_version", { simple: true })).toBe(2);

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

  describe("binding history durability", () => {
    it.each([
      ["id", "binding-poisoned"],
      ["conversation_id", "thread-poisoned"],
      ["generation", 10],
    ] as const)("rejects changing immutable current binding field %s", (column, value) => {
      const db = openDatabase(temporaryDatabasePath());
      try {
        seedStorage(db);
        expect(() => db.prepare(`UPDATE binding SET ${column} = ? WHERE id = 'binding-1'`).run(value)).toThrow();
      } finally {
        db.close();
      }
    });

    it("rejects every update after a binding becomes historical", () => {
      const db = openDatabase(temporaryDatabasePath());
      try {
        seedStorage(db);
        db.prepare(`
          UPDATE binding SET is_current = 0, inactive_at = 10, inactive_reason = 'rotated'
          WHERE id = 'binding-1'
        `).run();
        expect(() => db.prepare(`
          UPDATE binding SET inactive_reason = 'rewritten' WHERE id = 'binding-1'
        `).run()).toThrow();
      } finally {
        db.close();
      }
    });
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
      db.prepare("INSERT INTO binding (id, lane_id, workspace_id, adapter, conversation_id, generation, active_at, inactive_at, inactive_reason, is_current) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "binding-1", "lane-1", "workspace-1", "codex", "thread-1", 1,
        1, null, null, 1,
      );
      expect(() => db.prepare("INSERT INTO binding (id, lane_id, workspace_id, adapter, conversation_id, generation, active_at, inactive_at, inactive_reason, is_current) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
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
      db.prepare("INSERT INTO binding (id, lane_id, workspace_id, adapter, conversation_id, generation, active_at, inactive_at, inactive_reason, is_current) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "binding-2", "lane-1", "workspace-1", "codex", "thread-2", 2,
        1, 2, "rotated", 0,
      );
      expect(() => db.prepare("INSERT INTO binding (id, lane_id, workspace_id, adapter, conversation_id, generation, active_at, inactive_at, inactive_reason, is_current) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "binding-1", "lane-1", "workspace-1", "codex", "thread-1", 1,
        3, null, null, 1,
      )).toThrow();

      db.prepare("INSERT INTO binding (id, lane_id, workspace_id, adapter, conversation_id, generation, active_at, inactive_at, inactive_reason, is_current) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
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
