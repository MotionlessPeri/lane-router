import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type RouterDatabase } from "../../src/storage/database.js";
import { StaleBindingGenerationError } from "../../src/core/errors.js";
import {
  canonicalJson,
  CanonicalJsonError,
  OperationConflictError,
  OperationStore,
} from "../../src/storage/operation-store.js";
import { InvalidAckOutcomeError, StorageRepositories } from "../../src/storage/repositories.js";
import { seedStorage, STORAGE_IDS } from "../fixtures/storage/seed.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

function database(): RouterDatabase {
  const directory = mkdtempSync(join(tmpdir(), "lane-router-operations-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "router.sqlite"));
  seedStorage(database);
  return database;
}

function messageInput(id: string) {
  return {
    messageId: id,
    deliveryId: `delivery-${id}`,
    senderBindingId: STORAGE_IDS.bindingId,
    targetLaneId: STORAGE_IDS.laneId,
    kind: "normal" as const,
    body: `body-${id}`,
    metadata: { nested: { b: 2, a: 1 } },
    replyTo: null,
    createdAt: 100,
  };
}

describe("message and acknowledgement transactions", () => {
  it("atomically creates a message and unique monotonic initial delivery", () => {
    const db = database();
    try {
      const repositories = new StorageRepositories(db);
      expect(repositories.createMessageWithInitialDelivery(messageInput("one"))).toMatchObject({ sequence: 1 });
      expect(repositories.createMessageWithInitialDelivery(messageInput("two"))).toMatchObject({ sequence: 2 });
      expect((db.prepare("SELECT COUNT(*) count FROM message").get() as { count: number }).count).toBe(2);
      expect((db.prepare("SELECT COUNT(*) count FROM delivery").get() as { count: number }).count).toBe(2);
    } finally {
      db.close();
    }
  });

  it("reads the maximum safe sequence exactly and rejects allocation overflow atomically", () => {
    const db = database();
    try {
      const repositories = new StorageRepositories(db);
      repositories.createMessageWithInitialDelivery(messageInput("safe-max"));
      db.prepare("UPDATE delivery SET sequence=? WHERE id='delivery-safe-max'").run(Number.MAX_SAFE_INTEGER);
      expect(repositories.readDelivery("delivery-safe-max").sequence).toBe(Number.MAX_SAFE_INTEGER);
      expect(() => repositories.createMessageWithInitialDelivery(messageInput("overflow"))).toThrow();
      expect((db.prepare("SELECT COUNT(*) count FROM message").get() as { count: number }).count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rejects generation 999 claims instead of treating the caller as current", () => {
    const db = database();
    try {
      const repositories = new StorageRepositories(db);
      repositories.createMessageWithInitialDelivery(messageInput("stale-claim"));
      expect(() => repositories.createClaim({
        claimId: "claim-999", deliveryId: "delivery-stale-claim", generation: 999,
        leaseDeadlineAt: 500, createdAt: 200,
      })).toThrow(StaleBindingGenerationError);
      expect(db.prepare("SELECT * FROM claim").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects generation 999 acknowledgements against a poisoned durable claim", () => {
    const db = database();
    try {
      const repositories = new StorageRepositories(db);
      repositories.createMessageWithInitialDelivery(messageInput("stale-ack"));
      db.transaction(() => {
        db.exec("DROP TRIGGER claim_insert_must_match_delivery_context");
        db.prepare("UPDATE delivery SET state='claimed', deadline_kind='lease', deadline_at=500 WHERE id='delivery-stale-ack'").run();
        db.prepare(`
          INSERT INTO claim VALUES ('claim-999', 'delivery-stale-ack', 999, 500, 200, NULL, NULL)
        `).run();
      })();
      expect(() => repositories.acknowledge({
        deliveryId: "delivery-stale-ack", claimId: "claim-999", generation: 999,
        outcome: { kind: "recorded", summary: "done" }, acknowledgedAt: 300,
      })).toThrow(StaleBindingGenerationError);
      expect(db.prepare("SELECT * FROM ack").all()).toEqual([]);
      expect(db.prepare("SELECT state FROM delivery WHERE id='delivery-stale-ack'").get()).toEqual({ state: "claimed" });
    } finally {
      db.close();
    }
  });

  it("allows claim and acknowledgement only at the actual current bound generation", () => {
    const db = database();
    try {
      const repositories = new StorageRepositories(db);
      repositories.createMessageWithInitialDelivery(messageInput("current"));
      repositories.createClaim({
        claimId: "claim-current", deliveryId: "delivery-current", generation: 1,
        leaseDeadlineAt: 500, createdAt: 200,
      });
      expect(repositories.acknowledge({
        deliveryId: "delivery-current", claimId: "claim-current", generation: 1,
        outcome: { kind: "recorded", summary: "done" }, acknowledgedAt: 300,
      })).toMatchObject({ status: "acknowledged", bindingGeneration: 1 });
    } finally {
      db.close();
    }
  });

  it.each([
    [{ kind: "replied", replyMessageId: "missing-reply" }, "missing reply"],
    [{ kind: "recorded", summary: "   " }, "empty summary"],
    [{ kind: "recorded", summary: "done", documentPath: "C:\\outside.md" }, "absolute path"],
    [{ kind: "recorded", summary: "done", documentPath: "C:outside.md" }, "drive-relative path"],
    [{ kind: "recorded", summary: "done", documentPath: "../outside.md" }, "root traversal"],
    [{ kind: "recorded", summary: "done", documentPath: "docs/../../outside.md" }, "nested root traversal"],
    [{ kind: "recorded", summary: "done", documentPath: "\\\\server\\share\\file.md" }, "UNC path"],
    [{ kind: "recorded", summary: "done", documentPath: "docs/zero\0byte.md" }, "NUL path"],
    [{ kind: "recorded", summary: "done", externalTaskId: "  " }, "empty task ID"],
    [{ kind: "rejected", reason: "  " }, "empty rejection reason"],
  ] as const)("rejects invalid ack outcome: %s", (outcome, _label) => {
    const db = database();
    try {
      const repositories = new StorageRepositories(db);
      repositories.createMessageWithInitialDelivery(messageInput("invalid-outcome"));
      repositories.createClaim({
        claimId: "claim-invalid", deliveryId: "delivery-invalid-outcome", generation: 1,
        leaseDeadlineAt: 500, createdAt: 200,
      });
      expect(() => repositories.acknowledge({
        deliveryId: "delivery-invalid-outcome", claimId: "claim-invalid", generation: 1,
        outcome, acknowledgedAt: 300,
      })).toThrow(InvalidAckOutcomeError);
      expect(db.prepare("SELECT * FROM ack").all()).toEqual([]);
      expect(db.prepare("SELECT state FROM delivery WHERE id='delivery-invalid-outcome'").get()).toEqual({ state: "claimed" });
    } finally {
      db.close();
    }
  });

  it("rejects a replied outcome whose reply belongs to another message", () => {
    const db = database();
    try {
      const repositories = new StorageRepositories(db);
      repositories.createMessageWithInitialDelivery(messageInput("original"));
      repositories.createMessageWithInitialDelivery(messageInput("other"));
      repositories.createMessageWithInitialDelivery({ ...messageInput("wrong-reply"), replyTo: "other" });
      repositories.createClaim({
        claimId: "claim-original", deliveryId: "delivery-original", generation: 1,
        leaseDeadlineAt: 500, createdAt: 200,
      });
      expect(() => repositories.acknowledge({
        deliveryId: "delivery-original", claimId: "claim-original", generation: 1,
        outcome: { kind: "replied", replyMessageId: "wrong-reply" }, acknowledgedAt: 300,
      })).toThrow(InvalidAckOutcomeError);
    } finally {
      db.close();
    }
  });

  it("accepts a replied outcome only when the reply points to the acknowledged message", () => {
    const db = database();
    try {
      const repositories = new StorageRepositories(db);
      repositories.createMessageWithInitialDelivery(messageInput("reply-original"));
      repositories.createMessageWithInitialDelivery({
        ...messageInput("valid-reply"),
        replyTo: "reply-original",
      });
      repositories.createClaim({
        claimId: "claim-reply", deliveryId: "delivery-reply-original", generation: 1,
        leaseDeadlineAt: 500, createdAt: 200,
      });
      expect(repositories.acknowledge({
        deliveryId: "delivery-reply-original", claimId: "claim-reply", generation: 1,
        outcome: { kind: "replied", replyMessageId: "valid-reply" }, acknowledgedAt: 300,
      })).toMatchObject({
        status: "acknowledged",
        outcome: { kind: "replied", replyMessageId: "valid-reply" },
      });
    } finally {
      db.close();
    }
  });

  it("normalizes and copies valid ack outcome fields before persistence", () => {
    const db = database();
    try {
      const repositories = new StorageRepositories(db);
      repositories.createMessageWithInitialDelivery(messageInput("normalized"));
      repositories.createClaim({
        claimId: "claim-normalized", deliveryId: "delivery-normalized", generation: 1,
        leaseDeadlineAt: 500, createdAt: 200,
      });
      const outcome = {
        kind: "recorded" as const,
        summary: "  completed  ",
        documentPath: " docs/sub/../result.md ",
        externalTaskId: " TASK-1 ",
      };
      const acknowledged = repositories.acknowledge({
        deliveryId: "delivery-normalized", claimId: "claim-normalized", generation: 1,
        outcome, acknowledgedAt: 300,
      });
      outcome.summary = "mutated";
      expect(acknowledged).toMatchObject({ outcome: {
        kind: "recorded", summary: "completed", documentPath: "docs/result.md", externalTaskId: "TASK-1",
      } });
      expect(JSON.parse((db.prepare("SELECT outcome_payload_json FROM ack").get() as { outcome_payload_json: string }).outcome_payload_json)).toEqual({
        documentPath: "docs/result.md", externalTaskId: "TASK-1", kind: "recorded", summary: "completed",
      });
    } finally {
      db.close();
    }
  });

  it("rolls back sequence allocation and message when initial delivery creation fails", () => {
    const db = database();
    try {
      const repositories = new StorageRepositories(db, {
        afterMessageInsert: () => { throw new Error("injected delivery failure"); },
      });
      expect(() => repositories.createMessageWithInitialDelivery(messageInput("failed"))).toThrow("injected delivery failure");
      expect((db.prepare("SELECT COUNT(*) count FROM message").get() as { count: number }).count).toBe(0);
      expect((db.prepare("SELECT COUNT(*) count FROM delivery").get() as { count: number }).count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rolls back the ack row and acknowledged transition together", () => {
    const db = database();
    try {
      const base = new StorageRepositories(db);
      base.createMessageWithInitialDelivery(messageInput("ack"));
      base.createClaim({
        claimId: "claim-1", deliveryId: "delivery-ack", generation: 1,
        leaseDeadlineAt: 500, createdAt: 200,
      });
      const faulting = new StorageRepositories(db, {
        afterAckInsert: () => { throw new Error("injected ack failure"); },
      });
      expect(() => faulting.acknowledge({
        deliveryId: "delivery-ack", claimId: "claim-1", generation: 1,
        outcome: { kind: "recorded", summary: "done" }, acknowledgedAt: 300,
      })).toThrow("injected ack failure");
      expect(db.prepare("SELECT * FROM ack").all()).toEqual([]);
      expect(db.prepare("SELECT state FROM delivery WHERE id = ?").get("delivery-ack")).toEqual({ state: "claimed" });
    } finally {
      db.close();
    }
  });

  it("rejects a repository ack that names another delivery's claim", () => {
    const db = database();
    try {
      const repositories = new StorageRepositories(db);
      repositories.createMessageWithInitialDelivery(messageInput("ack-a"));
      repositories.createMessageWithInitialDelivery(messageInput("ack-b"));
      repositories.createClaim({ claimId: "claim-a", deliveryId: "delivery-ack-a", generation: 1, createdAt: 10, leaseDeadlineAt: 100 });
      repositories.createClaim({ claimId: "claim-b", deliveryId: "delivery-ack-b", generation: 1, createdAt: 10, leaseDeadlineAt: 100 });
      expect(() => repositories.acknowledge({
        deliveryId: "delivery-ack-a", claimId: "claim-b", generation: 1,
        outcome: { kind: "recorded", summary: "done" }, acknowledgedAt: 20,
      })).toThrow();
      expect(db.prepare("SELECT * FROM ack").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each([
    ["claim delivery mismatch", "delivery-direct-a", "claim-direct-b", 1, "recorded", '{"kind":"recorded","summary":"done"}'],
    ["generation mismatch", "delivery-direct-a", "claim-direct-a", 2, "recorded", '{"kind":"recorded","summary":"done"}'],
    ["outcome kind mismatch", "delivery-direct-a", "claim-direct-a", 1, "recorded", '{"kind":"rejected","reason":"no"}'],
  ] as const)("rejects direct ack insert with %s", (_label, deliveryId, claimId, generation, kind, payload) => {
    const db = database();
    try {
      const repositories = new StorageRepositories(db);
      repositories.createMessageWithInitialDelivery(messageInput("direct-a"));
      repositories.createMessageWithInitialDelivery(messageInput("direct-b"));
      repositories.createClaim({ claimId: "claim-direct-a", deliveryId: "delivery-direct-a", generation: 1, createdAt: 10, leaseDeadlineAt: 100 });
      repositories.createClaim({ claimId: "claim-direct-b", deliveryId: "delivery-direct-b", generation: 1, createdAt: 10, leaseDeadlineAt: 100 });
      expect(() => db.prepare(`
        INSERT INTO ack VALUES (?, ?, ?, ?, ?, 20)
      `).run(deliveryId, claimId, generation, kind, payload)).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("global operation IDs", () => {
  it("rejects an unsafe operation timestamp before executing its side effect", () => {
    const db = database();
    try {
      const operations = new OperationStore(db);
      let effects = 0;
      expect(() => operations.execute({
        operationId: "unsafe-time", actor: { kind: "admin", id: "admin-1" },
        method: "test", request: {}, createdAt: Number.MAX_SAFE_INTEGER + 1,
      }, () => ({ effects: ++effects }))).toThrow();
      expect(effects).toBe(0);
    } finally {
      db.close();
    }
  });

  it("replays the original typed result without repeating side effects or depending on JSON key order", () => {
    const db = database();
    try {
      const operations = new OperationStore(db);
      let effects = 0;
      const first = operations.execute({
        operationId: "operation-1",
        actor: { kind: "binding", id: STORAGE_IDS.bindingId },
        method: "lane_send",
        request: { b: 2, a: { y: 2, x: 1 } },
        createdAt: 100,
      }, () => ({ messageId: `message-${++effects}`, accepted: true }));
      const replay = operations.execute({
        operationId: "operation-1",
        actor: { kind: "binding", id: STORAGE_IDS.bindingId },
        method: "lane_send",
        request: { a: { x: 1, y: 2 }, b: 2 },
        createdAt: 999,
      }, () => ({ messageId: `message-${++effects}`, accepted: false }));

      expect(replay).toEqual(first);
      expect(effects).toBe(1);
    } finally {
      db.close();
    }
  });

  it.each([
    [{ kind: "admin", id: "admin-1" }, "lane_send", { a: 1 }],
    [{ kind: "binding", id: STORAGE_IDS.bindingId }, "lane_ack", { a: 1 }],
    [{ kind: "binding", id: STORAGE_IDS.bindingId }, "lane_send", { a: 2 }],
  ] as const)("rejects reuse by a different actor, method, or request", (actor, method, request) => {
    const db = database();
    try {
      const operations = new OperationStore(db);
      operations.execute({
        operationId: "operation-conflict", actor: { kind: "binding", id: STORAGE_IDS.bindingId },
        method: "lane_send", request: { a: 1 }, createdAt: 100,
      }, () => ({ ok: true }));
      expect(() => operations.execute({
        operationId: "operation-conflict", actor, method, request, createdAt: 101,
      }, () => ({ ok: false }))).toThrow(OperationConflictError);
    } finally {
      db.close();
    }
  });
});

describe("canonical JSON validation", () => {
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["undefined", undefined],
    ["function", () => 1],
    ["symbol", Symbol("value")],
    ["bigint", 1n],
    ["Date", new Date(0)],
    ["nested undefined", { nested: { value: undefined } }],
    ["sparse array", Array(2)],
    ["array undefined", [undefined]],
    ["unsupported prototype", new (class Value { value = 1; })()],
    ["symbol key", { [Symbol("key")]: 1 }],
  ] as const)("rejects %s without canonical collisions", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it("rejects cycles with the typed validation error", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it("sorts nested plain objects, accepts null prototypes, and normalizes negative zero", () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { z: -0, a: true });
    expect(canonicalJson({ b: nullPrototype, a: [1, "x", null] })).toBe(
      '{"a":[1,"x",null],"b":{"a":true,"z":0}}',
    );
  });
});
