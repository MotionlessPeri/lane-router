import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openRouterDatabase } from "../../src/router/database.js";
import { MailboxCorruptionError, MailboxStore } from "../../src/router/mailbox-store.js";
import { RouterStateStore } from "../../src/router/state-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-v1-mailbox-"));
  roots.push(root);
  const database = openRouterDatabase(":memory:");
  const state = new RouterStateStore(database);
  state.createLane({ address: "alpha/source", project: "alpha", roleDescription: "source", now: 1 });
  state.createLane({ address: "alpha/target", project: "alpha", roleDescription: "target", now: 1 });
  return { root, database, state, mailbox: new MailboxStore(root) };
}

const message = {
  id: "message-1", requestKey: "mcp:17", senderLane: "alpha/source", targetLane: "alpha/target",
  kind: "correction" as const, replyTo: "message-0", createdAt: 123, body: "Corrected details.\nSecond line.",
};

function seedReplyTarget(x: ReturnType<typeof setup>): void {
  const original = {
    id: "message-0", requestKey: "mcp:16", senderLane: "alpha/source", targetLane: "alpha/target",
    kind: "normal" as const, replyTo: null, createdAt: 100, body: "Original details.",
  };
  const written = x.mailbox.writePending(original);
  x.state.insertMessage({ ...original, relativePath: written.relativePath, contentSha256: written.contentSha256 });
}

describe("file mailbox", () => {
  it("atomically creates an immutable pending message with recoverable headers", () => {
    const x = setup();
    try {
      const written = x.mailbox.writePending(message);
      expect(readFileSync(written.absolutePath, "utf8")).toContain("request_key: mcp:17");
      expect(readFileSync(written.absolutePath, "utf8")).toContain("Corrected details.\nSecond line.");
      expect(() => x.mailbox.writePending({ ...message, body: "replacement" })).toThrow(/already exists/i);
      expect(readFileSync(written.absolutePath, "utf8")).toContain("Corrected details.");
    } finally {
      x.database.close();
    }
  });

  it("moves a pending file to resolved without changing its bytes", () => {
    const x = setup();
    try {
      const pending = x.mailbox.writePending(message);
      const before = readFileSync(pending.absolutePath);
      const resolved = x.mailbox.resolve(pending.relativePath);
      expect(readFileSync(resolved.absolutePath)).toEqual(before);
      expect(resolved.relativePath).toBe("mailboxes/alpha/target/resolved/message-1.md");
    } finally {
      x.database.close();
    }
  });

  it("recovers an orphan complete file into SQLite with the same request key", () => {
    const x = setup();
    try {
      seedReplyTarget(x);
      const written = x.mailbox.writePending(message);
      expect(x.state.messageByRequestKey(message.requestKey)).toBeUndefined();
      expect(x.mailbox.reconcile(x.state)).toEqual({ recovered: 1, moved: 0 });
      expect(x.state.messageByRequestKey(message.requestKey)).toEqual(expect.objectContaining({
        id: message.id, relativePath: written.relativePath, kind: "correction", replyTo: "message-0",
      }));
    } finally {
      x.database.close();
    }
  });

  it("recovers an orphan correction after its referenced orphan regardless of UUID filename order", () => {
    const x = setup();
    try {
      x.mailbox.writePending({
        id: "z-original", requestKey: "request:original", senderLane: "alpha/source", targetLane: "alpha/target",
        kind: "normal", replyTo: null, createdAt: 100, body: "Original.",
      });
      x.mailbox.writePending({
        id: "a-correction", requestKey: "request:correction", senderLane: "alpha/source", targetLane: "alpha/target",
        kind: "correction", replyTo: "z-original", createdAt: 101, body: "Correction.",
      });
      expect(x.mailbox.reconcile(x.state)).toEqual({ recovered: 2, moved: 0 });
      expect(x.state.requireMessage("a-correction").replyTo).toBe("z-original");
    } finally { x.database.close(); }
  });

  it("finishes a resolved database transition left in the pending directory", () => {
    const x = setup();
    try {
      seedReplyTarget(x);
      const written = x.mailbox.writePending(message);
      x.state.insertMessage({ ...message, relativePath: written.relativePath, contentSha256: written.contentSha256 });
      x.state.markMessagesResolved([message.id], { laneAddress: "alpha/target", generation: 2, now: 200 });
      expect(x.mailbox.reconcile(x.state)).toEqual({ recovered: 0, moved: 1 });
      expect(readFileSync(join(x.root, "mailboxes", "alpha", "target", "resolved", "message-1.md"), "utf8")).toContain("Corrected details.");
    } finally {
      x.database.close();
    }
  });

  it("reports corruption when SQLite references a missing message file", () => {
    const x = setup();
    try {
      seedReplyTarget(x);
      x.state.insertMessage({ ...message, relativePath: "mailboxes/alpha/target/pending/message-1.md", contentSha256: "a".repeat(64) });
      expect(() => x.mailbox.reconcile(x.state)).toThrow(MailboxCorruptionError);
    } finally {
      x.database.close();
    }
  });
});
