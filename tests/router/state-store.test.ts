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
      expect(tables.map((row) => row.name)).toEqual(["binding", "lane", "message", "message_archive"]);
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

describe("declared model", () => {
  it("defaults to nothing declared, and keeps a declaration across later role edits", () => {
    const { database, store } = setup();
    try {
      // Nothing declared is the state every existing lane is in, and it has to survive being
      // read back rather than turning into an empty string somewhere in the mapping.
      const plain = store.createLane({ address: "alpha/design", project: "alpha", roleDescription: "design", now: 1 });
      expect(plain.model).toBeNull();

      const declared = store.createLane({ address: "alpha/review", project: "alpha", roleDescription: "review", now: 1, model: "claude-opus-5" });
      expect(declared.model).toBe("claude-opus-5");

      // The role and the model are independent facts about the lane: editing one must not clear
      // the other, which is what makes `lane_attach_current` safe to call with only a role.
      expect(store.updateLaneRole("alpha/review", "review, revised", 2).model).toBe("claude-opus-5");
      expect(store.requireLane("alpha/review")).toMatchObject({ roleDescription: "review, revised", model: "claude-opus-5" });
    } finally { database.close(); }
  });

  it("sets, replaces and reports a declaration without validating the name", () => {
    const { database, store } = setup();
    try {
      store.createLane({ address: "alpha/design", project: "alpha", roleDescription: "design", now: 1 });
      expect(store.updateLaneModel("alpha/design", "sonnet", 2).model).toBe("sonnet");
      expect(store.updateLaneModel("alpha/design", "claude-opus-5", 3).model).toBe("claude-opus-5");

      // No allow-list: a model this build has never heard of must still be storable, because a
      // list of valid names goes stale and then rejects the models that actually exist.
      expect(store.updateLaneModel("alpha/design", "no-such-model-9", 4).model).toBe("no-such-model-9");
      expect(store.listLanes("alpha")[0]).toMatchObject({ model: "no-such-model-9" });

      expect(() => store.updateLaneModel("alpha/missing", "sonnet", 5)).toThrow(/not found/iu);
    } finally { database.close(); }
  });
});

describe("archiving", () => {
  it("archives a lane without touching anything else about it", () => {
    const { database, store } = setup();
    try {
      const created = store.createLane({ address: "alpha/design", project: "alpha", roleDescription: "design", now: 1, model: "sonnet" });
      expect(created.archivedAt).toBeNull();

      expect(store.archiveLane("alpha/design", 50).archivedAt).toBe(50);
      // Archiving is a state change, not an edit: the row and everything the lane says about
      // itself stay, which is the whole difference between this and deleting it. Read by id,
      // because the address it used to answer to no longer belongs to it.
      expect(store.laneById(created.id)).toMatchObject({
        id: created.id, address: "alpha/design", roleDescription: "design", model: "sonnet", createdAt: 1, archivedAt: 50,
      });
    } finally { database.close(); }
  });

  // The address goes straight back into circulation, and the new lane is a different lane: same
  // name, own identity, so every message already pointing at the old one still means the old one.
  it("frees the address for a new lane that is not the old one", () => {
    const { database, store } = setup();
    try {
      const original = store.createLane({ address: "alpha/design", project: "alpha", roleDescription: "first", now: 1 });
      store.archiveLane("alpha/design", 50);

      const replacement = store.createLane({ address: "alpha/design", project: "alpha", roleDescription: "second", now: 60 });
      expect(replacement.id).not.toBe(original.id);
      expect(store.requireLane("alpha/design")).toMatchObject({ id: replacement.id, roleDescription: "second", archivedAt: null });
      expect(store.laneById(original.id)).toMatchObject({ roleDescription: "first", archivedAt: 50 });

      // Only one of them may be in service: that is the half the address still has to guarantee.
      expect(() => store.createLane({ address: "alpha/design", project: "alpha", roleDescription: "third", now: 61 }))
        .toThrow(/constraint/iu);
    } finally { database.close(); }
  });

  it("lists lanes by service state, and reports an unknown address rather than passing silently", () => {
    const { database, store } = setup();
    try {
      for (const address of ["alpha/one", "alpha/two", "beta/three"]) {
        store.createLane({ address, project: address.split("/")[0]!, roleDescription: address, now: 1 });
      }
      store.archiveLane("alpha/two", 50);
      store.archiveLane("beta/three", 51);

      // listLanes stays the in-service view every existing caller already expects; the archived
      // ones need their own query because nothing else can see them once they leave the directory.
      expect(store.listLanes("alpha").map((lane) => lane.address)).toEqual(["alpha/one"]);
      expect(store.listArchivedLanes("alpha").map((lane) => lane.address)).toEqual(["alpha/two"]);
      expect(store.listArchivedLanes(undefined).map((lane) => lane.address)).toEqual(["alpha/two", "beta/three"]);

      // An address stops naming a lane the moment it is archived — the address is free again, so
      // answering with the archived row would be answering about the wrong lane. It is still
      // reachable two other ways: by identity, and by asking what used to be here.
      expect(store.lane("alpha/two")).toBeUndefined();
      expect(store.archivedLaneAt("alpha/two")?.archivedAt).toBe(50);
      const archivedId = store.listArchivedLanes("alpha")[0]!.id;
      expect(store.laneById(archivedId)?.archivedAt).toBe(50);

      expect(() => store.archiveLane("alpha/ghost", 60)).toThrow(/not found/iu);
    } finally { database.close(); }
  });
});
