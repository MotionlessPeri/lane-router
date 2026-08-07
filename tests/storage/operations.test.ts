import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type RouterDatabase } from "../../src/storage/database.js";
import { OperationConflictError, OperationStore } from "../../src/storage/operation-store.js";
import { StorageRepositories } from "../../src/storage/repositories.js";
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
});

describe("global operation IDs", () => {
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
