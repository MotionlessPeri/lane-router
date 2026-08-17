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

describe("binding cwd", () => {
  it("starts null, is updated for the active conversation binding, and reads back", () => {
    const { database, store } = setup();
    try {
      store.createLane({ address: "alpha/design", project: "alpha", roleDescription: "design", now: 1 });
      store.createBinding({ id: "binding-1", laneAddress: "alpha/design", backend: "claude", conversationId: "session-1", generation: 1, startup: {}, now: 2 });
      expect(store.activeBindingForLane("alpha/design")?.cwd).toBeNull();

      store.updateBindingCwd("claude", "session-1", "E:\\project");
      expect(store.activeBindingForLane("alpha/design")?.cwd).toBe("E:\\project");
      expect(store.activeBindingForConversation("claude", "session-1")?.cwd).toBe("E:\\project");

      // The latest report wins: a lane whose conversation moved directories must resume in the new one.
      store.updateBindingCwd("claude", "session-1", "E:\\elsewhere");
      expect(store.activeBindingForLane("alpha/design")?.cwd).toBe("E:\\elsewhere");
    } finally { database.close(); }
  });

  it("ignores reports for conversations without an active binding", () => {
    const { database, store } = setup();
    try {
      store.createLane({ address: "alpha/design", project: "alpha", roleDescription: "design", now: 1 });
      store.createBinding({ id: "binding-1", laneAddress: "alpha/design", backend: "claude", conversationId: "session-1", generation: 1, startup: {}, now: 2 });
      expect(() => store.updateBindingCwd("claude", "unknown-session", "E:\\project")).not.toThrow();
      expect(() => store.updateBindingCwd("codex", "session-1", "E:\\project")).not.toThrow();
      expect(store.activeBindingForLane("alpha/design")?.cwd).toBeNull();

      // An inactive binding keeps the cwd it had; only the active one receives new reports.
      store.updateBindingCwd("claude", "session-1", "E:\\project");
      store.deactivateBinding("binding-1", 1, 3);
      store.updateBindingCwd("claude", "session-1", "E:\\later");
      expect(store.binding("binding-1")?.cwd).toBe("E:\\project");
    } finally { database.close(); }
  });
});
