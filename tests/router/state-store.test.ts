import { describe, expect, it } from "vitest";

import { openRouterDatabase } from "../../src/router/database.js";
import { RouterStateStore } from "../../src/router/state-store.js";

function setup() {
  const database = openRouterDatabase(":memory:");
  return { database, store: new RouterStateStore(database) };
}

describe("V1 state store", () => {
  it("contains only lane, binding, and message domain tables", () => {
    const { database } = setup();
    try {
      const tables = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual(["binding", "lane", "message"]);
      const messageColumns = database.pragma("table_info(message)") as Array<{ name: string }>;
      expect(messageColumns.map((column) => column.name)).not.toContain("body");
      expect(messageColumns.map((column) => column.name)).not.toContain("metadata_json");
    } finally {
      database.close();
    }
  });

  it("groups lanes by project and preserves free-text role descriptions", () => {
    const { database, store } = setup();
    try {
      store.createLane({ address: "alpha/design", project: "alpha", roleDescription: "Owns design decisions.", now: 10 });
      store.createLane({ address: "alpha/test", project: "alpha", roleDescription: "Tests behavior.", now: 11 });
      store.createLane({ address: "beta/design", project: "beta", roleDescription: "Separate project.", now: 12 });
      expect(store.listLanes("alpha")).toEqual([
        expect.objectContaining({ address: "alpha/design", roleDescription: "Owns design decisions." }),
        expect.objectContaining({ address: "alpha/test", roleDescription: "Tests behavior." }),
      ]);
    } finally {
      database.close();
    }
  });

  it("allows only one active binding per lane and per backend conversation", () => {
    const { database, store } = setup();
    try {
      for (const address of ["alpha/design", "alpha/test"])
        store.createLane({ address, project: "alpha", roleDescription: address, now: 1 });
      store.createBinding({ id: "binding-1", laneAddress: "alpha/design", backend: "codex", conversationId: "thread-1", generation: 1, startup: {}, now: 2 });
      expect(() => store.createBinding({ id: "binding-2", laneAddress: "alpha/design", backend: "claude", conversationId: "session-2", generation: 2, startup: {}, now: 3 })).toThrow(/active binding/i);
      expect(() => store.createBinding({ id: "binding-3", laneAddress: "alpha/test", backend: "codex", conversationId: "thread-1", generation: 1, startup: {}, now: 3 })).toThrow(/active binding/i);
    } finally {
      database.close();
    }
  });

  it("stores message metadata and resolves request keys without storing bodies", () => {
    const { database, store } = setup();
    try {
      store.createLane({ address: "alpha/source", project: "alpha", roleDescription: "source", now: 1 });
      store.createLane({ address: "alpha/target", project: "alpha", roleDescription: "target", now: 1 });
      store.insertMessage({
        id: "message-1", requestKey: "codex:thread:call-1", senderLane: "alpha/source",
        targetLane: "alpha/target", kind: "normal", replyTo: null,
        relativePath: "mailboxes/alpha/target/pending/message-1.md", contentSha256: "a".repeat(64), createdAt: 2,
      });
      expect(store.messageByRequestKey("codex:thread:call-1")).toEqual(expect.objectContaining({ id: "message-1", state: "pending" }));
      expect(() => store.insertMessage({
        id: "message-2", requestKey: "codex:thread:call-1", senderLane: "alpha/source",
        targetLane: "alpha/target", kind: "normal", replyTo: null,
        relativePath: "mailboxes/alpha/target/pending/message-2.md", contentSha256: "b".repeat(64), createdAt: 3,
      })).toThrow();
    } finally {
      database.close();
    }
  });
});
