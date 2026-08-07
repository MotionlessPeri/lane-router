import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/storage/database.js";
import {
  LATEST_MIGRATION_VERSION,
  MIGRATION_V1_SQL,
  MIGRATION_V2_SQL,
  MIGRATION_V3_SQL,
  MIGRATION_V4_SQL,
} from "../../src/storage/migrations.js";
import { StorageRepositories } from "../../src/storage/repositories.js";
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
    legacy.exec(MIGRATION_V1_SQL);
    legacy.exec(`
      INSERT INTO project VALUES ('project-1', 'project', 'Project', 'manifest', 1, 1);
      INSERT INTO workspace VALUES ('workspace-1', 'project-1', 'C:/repo', 1, 1);
      INSERT INTO lane VALUES ('lane-1', 'project-1', 'lane', 'role.md', 0);
      INSERT INTO binding VALUES (
        'binding-legacy', 'lane-1', 'workspace-1', 'codex', 'thread-1',
        1, 1, NULL, NULL, 1
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const upgraded = openDatabase(path);
    try {
      expect(upgraded.pragma("user_version", { simple: true })).toBe(
        LATEST_MIGRATION_VERSION,
      );
      expect(upgraded.prepare(`
        SELECT state, state_changed_at, state_reason FROM binding WHERE id = 'binding-legacy'
      `).get()).toEqual({ state: "bound", state_changed_at: null, state_reason: null });
      expect(() => upgraded.prepare("UPDATE binding SET generation=10").run()).toThrow();
    } finally {
      upgraded.close();
    }
  });

  it("leaves a dirty migration-v1 database repairable when lifecycle preflight fails", () => {
    const path = temporaryDatabasePath();
    const legacy = new Database(path);
    legacy.exec(MIGRATION_V1_SQL);
    legacy.exec(`
      INSERT INTO project VALUES ('project-1', 'project', 'Project', 'manifest', 1, 1);
      INSERT INTO workspace VALUES ('workspace-1', 'project-1', 'C:/repo', 1, 1);
      INSERT INTO lane VALUES ('lane-1', 'project-1', 'lane', 'role.md', 0);
      INSERT INTO binding VALUES (
        'binding-dirty', 'lane-1', 'workspace-1', 'codex', 'thread-1',
        1, 1, 2, '   ', 0
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    expect(() => {
      const unexpectedlyOpened = openDatabase(path);
      unexpectedlyOpened.close();
    }).toThrow(/integrity|lifecycle/iu);
    const repair = new Database(path);
    try {
      expect(repair.pragma("user_version", { simple: true })).toBe(1);
      expect(repair.prepare("SELECT inactive_reason FROM binding").get()).toEqual({ inactive_reason: "   " });
      expect(() => repair.prepare("UPDATE binding SET inactive_reason='repaired'").run()).not.toThrow();
    } finally {
      repair.close();
    }
  });

  it("rolls back the entire v1 migration chain when v3 safe-integer preflight fails", () => {
    const path = temporaryDatabasePath();
    const legacy = new Database(path);
    legacy.exec(MIGRATION_V1_SQL);
    legacy.transaction(() => {
      legacy.prepare("INSERT INTO project VALUES (?, ?, ?, ?, ?, ?)").run("project-1", "project", "Project", "manifest", 1, 1);
      legacy.prepare("INSERT INTO workspace VALUES (?, ?, ?, ?, ?)").run("workspace-1", "project-1", "C:/repo", 1, 1);
      legacy.prepare("INSERT INTO lane VALUES (?, ?, ?, ?, ?)").run("lane-1", "project-1", "lane", "role.md", 0);
      legacy.prepare("INSERT INTO binding VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "binding-unsafe", "lane-1", "workspace-1", "codex", "thread-1", 1,
        Number.MAX_SAFE_INTEGER + 1, null, null, 1,
      );
      legacy.pragma("user_version = 1");
    })();
    legacy.close();

    expect(() => openDatabase(path)).toThrow(/unsafe integer/iu);
    const repair = new Database(path);
    try {
      expect(repair.pragma("user_version", { simple: true })).toBe(1);
      expect((repair.pragma("table_info(binding)") as Array<{ name: string }>).map((column) => column.name)).not.toContain("state");
      expect(repair.prepare(`
        SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (
          'binding_identity_is_immutable', 'binding_workspace_must_match_lane_project'
        )
      `).all()).toEqual([]);
      expect(() => repair.prepare("UPDATE binding SET active_at=1 WHERE id='binding-unsafe'").run()).not.toThrow();
    } finally {
      repair.close();
    }
  });

  it("leaves dirty migration-v2 claim and ack rows repairable when v3 preflight fails", () => {
    const path = temporaryDatabasePath();
    const setup = openDatabase(path);
    seedStorage(setup);
    const repositories = new StorageRepositories(setup);
    repositories.createMessageWithInitialDelivery({
      messageId: "message-dirty", deliveryId: "delivery-dirty",
      senderBindingId: "binding-1", targetLaneId: "lane-1", kind: "normal",
      body: "body", metadata: {}, replyTo: null, createdAt: 10,
    });
    repositories.createClaim({ claimId: "claim-dirty", deliveryId: "delivery-dirty", generation: 1, createdAt: 20, leaseDeadlineAt: 100 });
    repositories.acknowledge({
      deliveryId: "delivery-dirty", claimId: "claim-dirty", generation: 1,
      outcome: { kind: "recorded", summary: "done" }, acknowledgedAt: 30,
    });
    repositories.createMessageWithInitialDelivery({
      messageId: "message-dirty-claim", deliveryId: "delivery-dirty-claim",
      senderBindingId: "binding-1", targetLaneId: "lane-1", kind: "normal",
      body: "body", metadata: {}, replyTo: null, createdAt: 11,
    });
    repositories.createClaim({ claimId: "claim-dirty-active", deliveryId: "delivery-dirty-claim", generation: 1, createdAt: 21, leaseDeadlineAt: 100 });
    setup.exec(`
      DROP TRIGGER binding_workspace_must_match_lane_project;
      DROP TRIGGER workspace_project_change_must_preserve_bindings;
      DROP TRIGGER lane_project_change_must_preserve_bindings;
      DROP TRIGGER claim_insert_must_match_delivery_context;
      DROP TRIGGER ack_insert_must_match_claim_and_payload;
      UPDATE ack SET outcome_kind='rejected' WHERE delivery_id='delivery-dirty';
      UPDATE delivery SET deadline_at=10 WHERE id='delivery-dirty-claim';
      PRAGMA user_version=2;
    `);
    setup.close();

    expect(() => {
      const unexpectedlyOpened = openDatabase(path);
      unexpectedlyOpened.close();
    }).toThrow(/integrity|ack|claim/iu);
    const repair = new Database(path);
    try {
      expect(repair.pragma("user_version", { simple: true })).toBe(2);
      expect(() => repair.prepare("UPDATE ack SET outcome_kind='recorded'").run()).not.toThrow();
    } finally {
      repair.close();
    }
  });

  it("upgrades a clean migration-v2 database to migration v3", () => {
    const path = temporaryDatabasePath();
    const legacy = new Database(path);
    legacy.exec(MIGRATION_V1_SQL);
    legacy.exec(MIGRATION_V2_SQL);
    legacy.pragma("user_version = 2");
    legacy.close();

    const upgraded = openDatabase(path);
    try {
      expect(upgraded.pragma("user_version", { simple: true })).toBe(
        LATEST_MIGRATION_VERSION,
      );
      expect(upgraded.prepare(`
        SELECT name FROM sqlite_master WHERE type='trigger' AND name='ack_insert_must_match_claim_and_payload'
      `).get()).toEqual({ name: "ack_insert_must_match_claim_and_payload" });
    } finally {
      upgraded.close();
    }
  });

  it("upgrades migration v3 with durable manifest ownership backfill", () => {
    const path = temporaryDatabasePath();
    const v3 = openDatabase(path);
    seedStorage(v3);
    v3.exec(`
      DROP TABLE project_declaration;
      DROP TABLE workspace_manifest;
      PRAGMA user_version = 3;
    `);
    v3.close();

    const upgraded = openDatabase(path);
    try {
      expect(upgraded.pragma("user_version", { simple: true })).toBe(
        LATEST_MIGRATION_VERSION,
      );
      expect(
        upgraded
          .prepare(
            "SELECT project_id,owner_workspace_id FROM project_declaration",
          )
          .get(),
      ).toEqual({ project_id: "project-1", owner_workspace_id: "workspace-1" });
      expect(
        upgraded
          .prepare(
            "SELECT workspace_id,manifest_identity,LENGTH(declaration_digest) AS digest_length FROM workspace_manifest",
          )
          .get(),
      ).toEqual({
        workspace_id: "workspace-1",
        manifest_identity: "manifest-1",
        digest_length: 64,
      });
    } finally {
      upgraded.close();
    }
  });

  it("rolls back v4 when a v3 project declaration has no workspace owner", () => {
    const path = temporaryDatabasePath();
    const dirty = openDatabase(path);
    dirty.exec(`
      DROP TABLE project_declaration;
      DROP TABLE workspace_manifest;
      INSERT INTO project VALUES ('orphan', 'orphan', 'Orphan', 'hash', 1, 1);
      INSERT INTO lane VALUES ('orphan/a', 'orphan', 'a', 'a.md', 1);
      PRAGMA user_version = 3;
    `);
    dirty.close();

    expect(() => openDatabase(path)).toThrow(/no workspace owner/i);
    const repair = new Database(path);
    try {
      expect(repair.pragma("user_version", { simple: true })).toBe(3);
      expect(
        repair
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='project_declaration'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      repair.close();
    }
  });

  it.each(["binding", "claim", "ack"] as const)(
    "rejects repairable dirty-v3 %s cross-row corruption before v4",
    (corruption) => {
      const path = temporaryDatabasePath();
      const dirty = openDatabase(path);
      seedStorage(dirty);
      const repositories = new StorageRepositories(dirty);
      if (corruption === "binding") {
        dirty.exec(`
          DROP TRIGGER binding_workspace_must_match_lane_project;
          DROP TRIGGER binding_identity_is_immutable;
          DROP TRIGGER binding_update_must_be_lifecycle_transition;
          INSERT INTO project VALUES ('other-project', 'other', 'Other', 'other-hash', 1, 1);
          INSERT INTO workspace VALUES ('other-workspace', 'other-project', 'C:/other', 1, 1);
          UPDATE binding SET workspace_id='other-workspace' WHERE id='binding-1';
        `);
      } else {
        repositories.createMessageWithInitialDelivery({
          messageId: `dirty-${corruption}-message`,
          deliveryId: `dirty-${corruption}-delivery`,
          senderBindingId: "binding-1",
          targetLaneId: "lane-1",
          kind: "normal",
          body: "body",
          metadata: {},
          replyTo: null,
          createdAt: 10,
        });
        repositories.createClaim({
          claimId: `dirty-${corruption}-claim`,
          deliveryId: `dirty-${corruption}-delivery`,
          generation: 1,
          createdAt: 20,
          leaseDeadlineAt: 100,
        });
        if (corruption === "claim")
          dirty
            .prepare("UPDATE delivery SET deadline_at=101 WHERE id=?")
            .run("dirty-claim-delivery");
        else {
          repositories.acknowledge({
            deliveryId: "dirty-ack-delivery",
            claimId: "dirty-ack-claim",
            generation: 1,
            outcome: { kind: "recorded", summary: "done" },
            acknowledgedAt: 30,
          });
          dirty
            .prepare("UPDATE ack SET outcome_kind='rejected' WHERE delivery_id=?")
            .run("dirty-ack-delivery");
        }
      }
      dirty.exec(`
        DROP TABLE project_declaration;
        DROP TABLE workspace_manifest;
        PRAGMA user_version = 3;
      `);
      dirty.close();

      expect(() => {
        const unexpectedlyOpened = openDatabase(path);
        unexpectedlyOpened.close();
      }).toThrow(/integrity|ownership|claim|ack/i);
      const repair = new Database(path);
      try {
        expect(repair.pragma("user_version", { simple: true })).toBe(3);
        expect(
          repair
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='project_declaration'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        repair.close();
      }
    },
  );

  it.each([
    "delivery_pending",
    "claim_active",
    "claim_closed_for_park",
  ] as const)(
    "rejects dirty-v3 acknowledged state with %s before v4",
    (corruption) => {
      const path = temporaryDatabasePath();
      const dirty = openDatabase(path);
      seedStorage(dirty);
      const repositories = new StorageRepositories(dirty);
      repositories.createMessageWithInitialDelivery({
        messageId: "ack-state-message",
        deliveryId: "ack-state-delivery",
        senderBindingId: "binding-1",
        targetLaneId: "lane-1",
        kind: "normal",
        body: "body",
        metadata: {},
        replyTo: null,
        createdAt: 10,
      });
      repositories.createClaim({
        claimId: "ack-state-claim",
        deliveryId: "ack-state-delivery",
        generation: 1,
        createdAt: 20,
        leaseDeadlineAt: 100,
      });
      repositories.acknowledge({
        deliveryId: "ack-state-delivery",
        claimId: "ack-state-claim",
        generation: 1,
        outcome: { kind: "recorded", summary: "done" },
        acknowledgedAt: 30,
      });
      if (corruption === "delivery_pending") {
        dirty
          .prepare("UPDATE delivery SET state='pending' WHERE id='ack-state-delivery'")
          .run();
      } else if (corruption === "claim_active") {
        dirty
          .prepare(
            "UPDATE delivery SET state='claimed',deadline_kind='lease',deadline_at=100 WHERE id='ack-state-delivery'",
          )
          .run();
        dirty
          .prepare(
            "UPDATE claim SET closed_at=NULL,close_reason=NULL WHERE id='ack-state-claim'",
          )
          .run();
      } else {
        dirty
          .prepare(
            "UPDATE claim SET close_reason='parked' WHERE id='ack-state-claim'",
          )
          .run();
      }
      dirty.exec(`
        DROP TABLE project_declaration;
        DROP TABLE workspace_manifest;
        PRAGMA user_version = 3;
      `);
      dirty.close();

      expect(() => {
        const unexpectedlyOpened = openDatabase(path);
        unexpectedlyOpened.close();
      }).toThrow(/ack|acknowledged|integrity/i);
      const repair = new Database(path);
      try {
        expect(repair.pragma("user_version", { simple: true })).toBe(3);
        expect(
          repair
            .prepare(
              "SELECT state FROM delivery WHERE id='ack-state-delivery'",
            )
            .get(),
        ).toBeDefined();
        expect(
          repair
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='project_declaration'",
            )
            .get(),
        ).toBeUndefined();
        expect(() => {
          if (corruption === "delivery_pending")
            repair
              .prepare(
                "UPDATE delivery SET state='acknowledged' WHERE id='ack-state-delivery'",
              )
              .run();
          else if (corruption === "claim_active")
            repair.exec(`
              UPDATE claim SET closed_at=30,close_reason='acknowledged'
                WHERE id='ack-state-claim';
              UPDATE delivery SET state='acknowledged',deadline_kind=NULL,deadline_at=NULL
                WHERE id='ack-state-delivery';
            `);
          else
            repair
              .prepare(
                "UPDATE claim SET close_reason='acknowledged' WHERE id='ack-state-claim'",
              )
              .run();
        }).not.toThrow();
      } finally {
        repair.close();
      }
    },
  );

  it("upgrades a legitimate acknowledged v3 delivery to v4", () => {
    const path = temporaryDatabasePath();
    const clean = openDatabase(path);
    seedStorage(clean);
    const repositories = new StorageRepositories(clean);
    repositories.createMessageWithInitialDelivery({
      messageId: "clean-ack-message",
      deliveryId: "clean-ack-delivery",
      senderBindingId: "binding-1",
      targetLaneId: "lane-1",
      kind: "normal",
      body: "body",
      metadata: {},
      replyTo: null,
      createdAt: 10,
    });
    repositories.createClaim({
      claimId: "clean-ack-claim",
      deliveryId: "clean-ack-delivery",
      generation: 1,
      createdAt: 20,
      leaseDeadlineAt: 100,
    });
    repositories.acknowledge({
      deliveryId: "clean-ack-delivery",
      claimId: "clean-ack-claim",
      generation: 1,
      outcome: { kind: "recorded", summary: "done" },
      acknowledgedAt: 30,
    });
    clean.exec(`
      DROP TABLE project_declaration;
      DROP TABLE workspace_manifest;
      PRAGMA user_version = 3;
    `);
    clean.close();

    const upgraded = openDatabase(path);
    try {
      expect(upgraded.pragma("user_version", { simple: true })).toBe(
        LATEST_MIGRATION_VERSION,
      );
      expect(
        upgraded
          .prepare(
            "SELECT d.state,c.closed_at,c.close_reason FROM delivery d JOIN ack a ON a.delivery_id=d.id JOIN claim c ON c.id=a.claim_id WHERE d.id='clean-ack-delivery'",
          )
          .get(),
      ).toEqual({
        state: "acknowledged",
        closed_at: 30,
        close_reason: "acknowledged",
      });
    } finally {
      upgraded.close();
    }
  });

  it("upgrades a clean v4 database to v5 manifest ownership and index support", () => {
    const path = temporaryDatabasePath();
    const v4 = new Database(path);
    v4.exec(MIGRATION_V1_SQL);
    v4.exec(MIGRATION_V2_SQL);
    v4.exec(MIGRATION_V3_SQL);
    v4.exec(MIGRATION_V4_SQL);
    v4.pragma("user_version = 4");
    seedStorage(v4);
    v4.prepare(
      "INSERT INTO workspace_manifest(workspace_id,manifest_identity,declaration_digest) VALUES('workspace-1','manifest-1','digest')",
    ).run();
    v4.prepare(
      "INSERT INTO project_declaration(project_id,owner_workspace_id,declaration_digest) VALUES('project-1','workspace-1','digest')",
    ).run();
    v4.close();

    const upgraded = openDatabase(path);
    try {
      expect(upgraded.pragma("user_version", { simple: true })).toBe(5);
      expect(
        (upgraded.pragma("table_info(event)") as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      ).toContain("lane_id");
      expect(
        upgraded
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name='workspace_project_change_must_preserve_declaration_ownership'",
          )
          .get(),
      ).toBeDefined();
    } finally {
      upgraded.close();
    }
  });

  it("rejects dirty v4 declaration ownership and leaves it repairable", () => {
    const path = temporaryDatabasePath();
    const dirty = new Database(path);
    dirty.exec(MIGRATION_V1_SQL);
    dirty.exec(MIGRATION_V2_SQL);
    dirty.exec(MIGRATION_V3_SQL);
    dirty.exec(MIGRATION_V4_SQL);
    dirty.pragma("user_version = 4");
    seedStorage(dirty);
    dirty.exec(`
      INSERT INTO project VALUES ('other-project','other','Other','other',1,1);
      INSERT INTO workspace_manifest VALUES ('workspace-1','manifest-1','digest');
      INSERT INTO project_declaration VALUES ('project-1','workspace-1','digest');
      DELETE FROM binding;
      UPDATE workspace SET project_id='other-project' WHERE id='workspace-1';
      PRAGMA user_version = 4;
    `);
    dirty.close();

    expect(() => {
      const unexpectedlyOpened = openDatabase(path);
      unexpectedlyOpened.close();
    }).toThrow(/declaration.*owner|ownership|integrity/i);
    const repair = new Database(path);
    try {
      expect(repair.pragma("user_version", { simple: true })).toBe(4);
      expect(
        repair
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='delivery_scheduler_order_idx'",
          )
          .get(),
      ).toBeUndefined();
      expect(() =>
        repair
          .prepare("UPDATE workspace SET project_id='project-1' WHERE id='workspace-1'")
          .run(),
      ).not.toThrow();
    } finally {
      repair.close();
    }
  });

  it("prevents moving a workspace that owns project declarations", () => {
    const db = openDatabase(temporaryDatabasePath());
    try {
      seedStorage(db);
      db.exec(`
        INSERT INTO project VALUES ('other-project','other','Other','other',1,1);
        INSERT INTO workspace_manifest VALUES ('workspace-1','manifest-1','digest');
        INSERT INTO project_declaration VALUES ('project-1','workspace-1','digest');
        DELETE FROM binding;
      `);
      expect(() =>
        db
          .prepare("UPDATE workspace SET project_id='other-project' WHERE id='workspace-1'")
          .run(),
      ).toThrow(/declaration|ownership/i);
    } finally {
      db.close();
    }
  });

  it("uses v5 indexes for scheduler, recovery, and foreign-key hot paths", () => {
    const db = openDatabase(temporaryDatabasePath());
    try {
      const cases = [
        [
          "delivery_scheduler_order_idx",
          "SELECT id FROM delivery WHERE target_lane_id=? AND state=? ORDER BY sequence",
          ["lane-1", "pending"],
        ],
        [
          "delivery_recovery_deadline_idx",
          "SELECT id FROM delivery WHERE state=? AND deadline_at<=?",
          ["notified", 100],
        ],
        [
          "claim_recovery_deadline_idx",
          "SELECT id FROM claim WHERE closed_at IS NULL AND lease_deadline_at<=?",
          [100],
        ],
        ["binding_workspace_idx", "SELECT id FROM binding WHERE workspace_id=?", ["workspace-1"]],
        ["message_target_lane_idx", "SELECT id FROM message WHERE target_lane_id=?", ["lane-1"]],
        ["message_sender_binding_idx", "SELECT id FROM message WHERE sender_binding_id=?", ["binding-1"]],
        ["delivery_message_idx", "SELECT id FROM delivery WHERE message_id=?", ["message-1"]],
        ["claim_delivery_idx", "SELECT id FROM claim WHERE delivery_id=?", ["delivery-1"]],
        ["ack_claim_idx", "SELECT delivery_id FROM ack WHERE claim_id=?", ["claim-1"]],
        ["event_delivery_idx", "SELECT id FROM event WHERE delivery_id=?", ["delivery-1"]],
        ["event_lane_idx", "SELECT id FROM event WHERE lane_id=?", ["lane-1"]],
      ] as const;
      for (const [index, sql, parameters] of cases) {
        const plan = db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...parameters)
          .map((row) => (row as { detail: string }).detail)
          .join("\n");
        expect(plan, sql).toContain(index);
      }
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(indexes).not.toContain("ack_delivery_idx");
      expect(indexes).not.toContain("delivery_target_lane_idx");
    } finally {
      db.close();
    }
  });

  it.each(["unbound", "rebuilt"] as const)(
    "upgrades a v2 database with an internally valid historical claim after binding is %s",
    (bindingState) => {
      const path = temporaryDatabasePath();
      const legacy = new Database(path);
      legacy.exec(MIGRATION_V1_SQL);
      legacy.exec(MIGRATION_V2_SQL);
      legacy.exec(`
        INSERT INTO project VALUES ('project-1', 'project', 'Project', 'manifest', 1, 1);
        INSERT INTO workspace VALUES ('workspace-1', 'project-1', 'C:/repo', 1, 1);
        INSERT INTO lane VALUES ('lane-1', 'project-1', 'lane', 'role.md', 0);
      `);
      if (bindingState === "unbound") {
        legacy.exec(`
          INSERT INTO binding (
            id, lane_id, workspace_id, adapter, conversation_id, generation,
            active_at, inactive_at, inactive_reason, is_current, state, state_changed_at, state_reason
          ) VALUES ('binding-1', 'lane-1', 'workspace-1', 'codex', 'thread-1', 1, 1, NULL, NULL, 1, 'unbound', 20, 'missing');
        `);
      } else {
        legacy.exec(`
          INSERT INTO binding (
            id, lane_id, workspace_id, adapter, conversation_id, generation,
            active_at, inactive_at, inactive_reason, is_current, state, state_changed_at, state_reason
          ) VALUES ('binding-1', 'lane-1', 'workspace-1', 'codex', 'thread-1', 1, 1, 20, 'rebuilt', 0, 'bound', NULL, NULL);
          INSERT INTO binding (
            id, lane_id, workspace_id, adapter, conversation_id, generation,
            active_at, inactive_at, inactive_reason, is_current, state, state_changed_at, state_reason
          ) VALUES ('binding-2', 'lane-1', 'workspace-1', 'codex', 'thread-2', 2, 20, NULL, NULL, 1, 'bound', NULL, NULL);
        `);
      }
      legacy.exec(`
        INSERT INTO message VALUES ('message-1', 'binding-1', 'lane-1', 'normal', 'body', '{}', NULL, 2);
        INSERT INTO delivery VALUES ('delivery-1', 'message-1', 'lane-1', 1, 'claimed', 0, 'lease', 100, NULL, NULL, NULL, NULL, 3);
        INSERT INTO claim VALUES ('claim-1', 'delivery-1', 1, 100, 3, NULL, NULL);
        PRAGMA user_version=2;
      `);
      legacy.close();

      const upgraded = openDatabase(path);
      try {
        expect(upgraded.pragma("user_version", { simple: true })).toBe(
          LATEST_MIGRATION_VERSION,
        );
        expect(upgraded.prepare("SELECT generation, lease_deadline_at FROM claim WHERE id='claim-1'").get()).toEqual({
          generation: 1, lease_deadline_at: 100,
        });
      } finally {
        upgraded.close();
      }
    },
  );

  it("creates the durable broker model with manifest ownership and WAL", () => {
    const path = temporaryDatabasePath();
    const connection = openDatabase(path);

    expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(connection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(connection.pragma("user_version", { simple: true })).toBe(
      LATEST_MIGRATION_VERSION,
    );

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
      "workspace_manifest",
      "project_declaration",
    ]));
    expect(
      connection
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_manifest'")
        .get(),
    ).toEqual({ name: "workspace_manifest" });

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

  it("rejects a direct binding whose workspace belongs to another project", () => {
    const db = openDatabase(temporaryDatabasePath());
    try {
      seedStorage(db);
      db.transaction(() => {
        db.prepare("INSERT INTO project VALUES (?, ?, ?, ?, ?, ?)").run("project-2", "other-project", "Other", "manifest-2", 1, 2);
        db.prepare("INSERT INTO workspace VALUES (?, ?, ?, ?, ?)").run("workspace-other", "project-2", "C:/other", 1, 2);
        db.prepare("UPDATE binding SET is_current=0, inactive_at=2, inactive_reason='rotate' WHERE id='binding-1'").run();
      })();
      expect(() => db.prepare(`
        INSERT INTO binding (
          id, lane_id, workspace_id, adapter, conversation_id, generation,
          active_at, inactive_at, inactive_reason, is_current
        ) VALUES ('binding-wrong', 'lane-1', 'workspace-other', 'codex', 'thread-2', 2, 3, NULL, NULL, 1)
      `).run()).toThrow();
    } finally {
      db.close();
    }
  });

  it("rejects persisted integers outside the JavaScript safe range", () => {
    const db = openDatabase(temporaryDatabasePath());
    try {
      expect(() => db.prepare("INSERT INTO project VALUES (?, ?, ?, ?, ?, ?)").run(
        "project-unsafe", "unsafe", "Unsafe", "manifest", 1, Number.MAX_SAFE_INTEGER + 1,
      )).toThrow();
    } finally {
      db.close();
    }
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
