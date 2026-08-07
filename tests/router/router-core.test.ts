import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PlatformBackend } from "../../src/router/backend.js";
import { BackendRegistry } from "../../src/router/backend.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { NotificationPump } from "../../src/router/notification-pump.js";
import { RouterCore, RouterError } from "../../src/router/router-core.js";
import { RouterStateStore } from "../../src/router/state-store.js";
import type { BindingRecord } from "../../src/router/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeBackend implements PlatformBackend {
  readonly name = "codex" as const;
  readonly waited: BindingRecord[] = [];
  wait?: () => Promise<void>;

  async notifyNormal(): Promise<"delivered"> { return "delivered"; }
  async notifyCorrection(): Promise<"delivered"> { return "delivered"; }
  async waitUntilReplaceable(binding: BindingRecord): Promise<void> {
    this.waited.push(binding);
    await this.wait?.();
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-core-"));
  roots.push(root);
  const database = openRouterDatabase(":memory:");
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(root);
  const backend = new FakeBackend();
  const backends = new BackendRegistry([backend]);
  let sequence = 0;
  let now = 100;
  const pump = new NotificationPump(state, mailbox, backends);
  const core = new RouterCore({
    state, mailbox, backends, pump,
    newId: (kind) => `${kind}-${++sequence}`,
    now: () => ++now,
  });
  return { root, database, state, mailbox, backend, pump, core };
}

const caller = (conversationId: string, requestKey = `request:${conversationId}`) => ({
  backend: "codex" as const,
  conversationId,
  requestKey,
});

describe("RouterCore directory and attach", () => {
  it("allows an unbound caller to inspect one project", async () => {
    const x = setup();
    try {
      x.state.createLane({ address: "alpha/design", project: "alpha", roleDescription: "Own design.", now: 1 });
      x.state.createLane({ address: "beta/test", project: "beta", roleDescription: "Own tests.", now: 1 });
      expect(await x.core.directory("alpha")).toEqual([
        { address: "alpha/design", roleDescription: "Own design.", bound: false, backend: null },
      ]);
    } finally { x.database.close(); }
  });

  it("requires a role for a new lane and returns bootstrap context", async () => {
    const x = setup();
    try {
      await expect(x.core.attachCurrent(caller("thread-a"), { address: "alpha/design" }))
        .rejects.toMatchObject({ code: "ROLE_REQUIRED" });
      const result = await x.core.attachCurrent(caller("thread-a"), {
        address: "alpha/design", roleDescription: "Own design decisions.",
      });
      expect(result).toEqual(expect.objectContaining({
        lane: expect.objectContaining({ address: "alpha/design", roleDescription: "Own design decisions." }),
        generation: 1,
        directory: [expect.objectContaining({ address: "alpha/design", bound: true })],
      }));
      expect(result.pendingPath.replaceAll("\\", "/")).toContain("/mailboxes/alpha/design/pending");
    } finally { x.database.close(); }
  });

  it("is idempotent for the current lane and refuses to repurpose a bound conversation", async () => {
    const x = setup();
    try {
      const first = await x.core.attachCurrent(caller("thread-a"), { address: "alpha/design", roleDescription: "Design." });
      const again = await x.core.attachCurrent(caller("thread-a", "request:again"), { address: "alpha/design" });
      expect(again.binding.id).toBe(first.binding.id);
      await expect(x.core.attachCurrent(caller("thread-a", "request:other"), {
        address: "alpha/test", roleDescription: "Test.",
      })).rejects.toMatchObject({ code: "CONVERSATION_ALREADY_BOUND" });
    } finally { x.database.close(); }
  });

  it("waits for the old binding, increments generation, and invalidates the old caller", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("thread-old"), { address: "alpha/design", roleDescription: "Design." });
      const replacement = await x.core.attachCurrent(caller("thread-new", "request:new"), { address: "alpha/design" });
      expect(x.backend.waited).toHaveLength(1);
      expect(replacement.generation).toBe(2);
      await expect(x.core.send(caller("thread-old", "request:stale"), {
        target: "alpha/design", body: "stale", kind: "normal",
      })).rejects.toMatchObject({ code: "NOT_ATTACHED" });
    } finally { x.database.close(); }
  });

  it("uses the observed binding generation as a replacement CAS", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("thread-old"), { address: "alpha/design", roleDescription: "Design." });
      let release!: () => void;
      x.backend.wait = () => new Promise<void>((resolve) => { release = resolve; });
      const losing = x.core.attachCurrent(caller("thread-loser", "request:loser"), { address: "alpha/design" });
      await Promise.resolve();
      x.backend.wait = undefined;
      await x.core.attachCurrent(caller("thread-winner", "request:winner"), { address: "alpha/design" });
      release();
      await expect(losing).rejects.toEqual(expect.objectContaining<Partial<RouterError>>({ code: "BINDING_CHANGED" }));
      expect(x.state.activeBindingForLane("alpha/design")?.conversationId).toBe("thread-winner");
    } finally { x.database.close(); }
  });

  it("updates an existing role only when a different role is explicit", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("thread-old"), { address: "alpha/design", roleDescription: "Old role." });
      await x.core.attachCurrent(caller("thread-new", "request:new"), { address: "alpha/design" });
      expect(x.state.requireLane("alpha/design").roleDescription).toBe("Old role.");
      await x.core.attachCurrent(caller("thread-new", "request:update"), { address: "alpha/design", roleDescription: "New role." });
      expect(x.state.requireLane("alpha/design").roleDescription).toBe("New role.");
    } finally { x.database.close(); }
  });
});

describe("RouterCore send and ack", () => {
  it("writes one immutable message body to the mailbox and deduplicates a tool retry", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("source"), { address: "alpha/source", roleDescription: "Source." });
      await x.core.attachCurrent(caller("target", "attach:target"), { address: "alpha/target", roleDescription: "Target." });
      const input = { target: "alpha/target", body: "Do the work.", kind: "normal" as const };
      const sent = await x.core.send(caller("source", "send:1"), input);
      const retried = await x.core.send(caller("source", "send:1"), input);
      expect(retried.id).toBe(sent.id);
      expect(x.state.allMessages()).toHaveLength(1);
      expect(readFileSync(join(x.root, sent.relativePath), "utf8")).toContain("Do the work.");
      const columns = x.database.pragma("table_info(message)") as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain("body");
    } finally { x.database.close(); }
  });

  it("validates target and correction reply_to", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("source"), { address: "alpha/source", roleDescription: "Source." });
      await expect(x.core.send(caller("source", "send:missing"), {
        target: "alpha/missing", body: "Hello", kind: "normal",
      })).rejects.toMatchObject({ code: "LANE_NOT_FOUND" });
      await x.core.attachCurrent(caller("target", "attach:target"), { address: "alpha/target", roleDescription: "Target." });
      await expect(x.core.send(caller("source", "send:correction"), {
        target: "alpha/target", body: "Correction", kind: "correction",
      })).rejects.toMatchObject({ code: "REPLY_TO_REQUIRED" });
    } finally { x.database.close(); }
  });

  it("batch-acks only pending messages owned by the current lane", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("source"), { address: "alpha/source", roleDescription: "Source." });
      await x.core.attachCurrent(caller("target", "attach:target"), { address: "alpha/target", roleDescription: "Target." });
      const first = await x.core.send(caller("source", "send:1"), { target: "alpha/target", body: "One", kind: "normal" });
      const second = await x.core.send(caller("source", "send:2"), { target: "alpha/target", body: "Two", kind: "normal" });
      await expect(x.core.ack(caller("source", "ack:wrong"), { messageIds: [first.id] }))
        .rejects.toMatchObject({ code: "MESSAGE_NOT_OWNED" });
      const result = await x.core.ack(caller("target", "ack:target"), { messageIds: [first.id, second.id] });
      expect(result.resolved).toEqual([first.id, second.id]);
      expect(x.state.requireMessage(first.id)).toEqual(expect.objectContaining({ state: "resolved", ackGeneration: 1 }));
      expect(join(x.root, x.state.requireMessage(first.id).relativePath).replaceAll("\\", "/")).toContain("/resolved/");
    } finally { x.database.close(); }
  });
});
