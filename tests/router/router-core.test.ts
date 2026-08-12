import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PlatformBackend, ReachSnapshot } from "../../src/router/backend.js";
import type { CallerContext, ResolvedIdentity } from "../../src/router/types.js";
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
  readonly name: "claude" | "codex";
  readonly waited: BindingRecord[] = [];
  readonly notified: BindingRecord[] = [];
  wait?: () => Promise<void>;

  constructor(name: "claude" | "codex" = "codex") { this.name = name; }

  reachState: ReachSnapshot = { state: "live", connectedAt: 10, lastLifecycleAt: 20, lastNotifiedAt: 30, believedBusy: false };

  async notifyNormal(binding: BindingRecord): Promise<"sent"> { this.notified.push(binding); return "sent"; }
  async notifyCorrection(binding: BindingRecord): Promise<"sent"> { this.notified.push(binding); return "sent"; }
  onAttentionOpportunity(): () => void { return () => undefined; }
  reach(): ReachSnapshot { return this.reachState; }
  identities = new Map<string, string>();
  resolveIdentity(context: CallerContext): ResolvedIdentity {
    const joined = context.joinKey === undefined ? undefined : this.identities.get(context.joinKey);
    return joined === undefined ? { value: context.conversationId, source: "caller" } : { value: joined, source: "joined" };
  }
  validateAttach?(context: CallerContext): string | undefined;
  async waitUntilReplaceable(binding: BindingRecord, signal?: AbortSignal): Promise<void> {
    this.waited.push(binding);
    if (this.wait) await Promise.race([this.wait(), abortion(signal)]);
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

/** Rejects with the signal's reason, so a fake wait can be given up on the way a real one is. */
function abortion(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const caller = (conversationId: string, requestKey = `request:${conversationId}`) => ({
  backend: "codex" as const,
  conversationId,
  requestKey,
});

describe("Claude attach readiness", () => {
  it("rejects an unjoined Claude caller before creating a lane", async () => {
    const x = setup();
    try {
      const claude = new FakeBackend("claude");
      claude.validateAttach = () => "Claude conversation identity is not joined and live";
      const core = new RouterCore({
        state: x.state, mailbox: x.mailbox, backends: new BackendRegistry([claude]), pump: x.pump,
        newId: () => "binding-claude", now: () => 1,
      });
      await expect(core.attachCurrent({ backend: "claude", conversationId: "mcp", requestKey: "attach" }, {
        address: "alpha/design", roleDescription: "Design.",
      })).rejects.toMatchObject({ code: "ATTACH_PRECONDITION_FAILED" });
      expect(x.state.lane("alpha/design")).toBeUndefined();
    } finally { x.database.close(); }
  });
});

describe("RouterCore directory and attach", () => {
  it("allows an unbound caller to inspect one project", async () => {
    const x = setup();
    try {
      x.state.createLane({ address: "alpha/design", project: "alpha", roleDescription: "Own design.", now: 1 });
      x.state.createLane({ address: "beta/test", project: "beta", roleDescription: "Own tests.", now: 1 });
      expect(await x.core.directory("alpha")).toEqual([
        { address: "alpha/design", roleDescription: "Own design.", backend: null, binding: null, reach: null },
      ]);
    } finally { x.database.close(); }
  });

  // Acceptance: a lane must still recognise its conversation after the process that speaks for
  // it restarts. Before this, the binding held that process's own id, so every restart produced
  // a binding nobody could reach and the lane had to be attached again.
  it("keeps the lane bound to the conversation when the calling process restarts", async () => {
    const x = setup();
    try {
      x.backend.identities.set("session-key-before", "conversation-1");
      const first = await x.core.attachCurrent(
        { backend: "codex", conversationId: "process-before", joinKey: "session-key-before", requestKey: "attach-1" },
        { address: "alpha/design", roleDescription: "Design." },
      );
      expect(first.binding.conversationId).toBe("conversation-1");
      expect(first.identity).toEqual({ value: "conversation-1", source: "joined" });

      // The session restarts: new process, new join key, same conversation.
      x.backend.identities.set("session-key-after", "conversation-1");
      const restarted = { backend: "codex" as const, conversationId: "process-after", joinKey: "session-key-after", requestKey: "send-1" };
      await x.core.attachCurrent({ ...restarted, requestKey: "attach-2" }, { address: "alpha/design" });

      // Same generation: nothing was taken over, the conversation was simply recognised.
      expect(x.state.activeBindingForLane("alpha/design")).toMatchObject({ generation: 1, conversationId: "conversation-1" });
      x.state.createLane({ address: "alpha/other", project: "alpha", roleDescription: "Other.", now: 1 });
      await expect(x.core.send(restarted, { target: "alpha/other", kind: "normal", body: "still me" }))
        .resolves.toMatchObject({ senderLane: "alpha/design" });
    } finally { x.database.close(); }
  });

  it("falls back to what the caller names itself when nothing has joined yet", async () => {
    const x = setup();
    try {
      const result = await x.core.attachCurrent(
        { backend: "codex", conversationId: "process-only", joinKey: "unjoined-key", requestKey: "attach-1" },
        { address: "alpha/design", roleDescription: "Design." },
      );
      expect(result.identity).toEqual({ value: "process-only", source: "caller" });
      expect(result.binding.conversationId).toBe("process-only");
    } finally { x.database.close(); }
  });

  it("reports ownership and reachability as separate answers", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("thread-a"), { address: "alpha/design", roleDescription: "Design." });
      x.backend.reachState = { state: "no_channel", connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null };

      // The lane still has an owner; what changed is that the Router can no longer get to it.
      // One boolean used to answer both, and it answered the wrong one during a failure.
      expect(x.core.directory("alpha")).toEqual([expect.objectContaining({
        address: "alpha/design",
        backend: "codex",
        binding: { generation: 1, attachedAt: expect.any(Number) },
        reach: expect.objectContaining({ state: "no_channel" }),
      })]);
    } finally { x.database.close(); }
  });

  it("still answers for a lane whose backend this Router does not run", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("thread-a"), { address: "alpha/design", roleDescription: "Design." });
      // A Router with no Claude backend registered must not make lane_directory throw.
      const withoutBackends = new RouterCore({
        state: x.state, mailbox: x.mailbox, backends: new BackendRegistry([]), pump: x.pump,
        newId: (kind) => `${kind}-x`, now: () => 1,
      });
      expect(withoutBackends.directory("alpha")).toEqual([expect.objectContaining({
        address: "alpha/design",
        binding: { generation: 1, attachedAt: expect.any(Number) },
        reach: null,
      })]);
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
        directory: [expect.objectContaining({
          address: "alpha/design",
          binding: { generation: 1, attachedAt: expect.any(Number) },
          reach: expect.objectContaining({ state: "live" }),
        })],
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

  it("offers a backlog to the conversation that just took the lane over", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("source"), { address: "alpha/source", roleDescription: "Source." });
      await x.core.attachCurrent(caller("target", "attach:target"), { address: "alpha/target", roleDescription: "Target." });
      await x.core.send(caller("source", "send:1"), { target: "alpha/target", body: "One", kind: "normal" });
      x.backend.notified.length = 0;

      await x.core.attachCurrent(caller("successor", "attach:successor"), { address: "alpha/target" });

      expect(x.backend.notified.map((binding) => binding.conversationId)).toEqual(["successor"]);
    } finally { x.database.close(); }
  });
});

describe("RouterCore attach when the lane is held by a busy conversation", () => {
  it("reports what it was waiting for instead of leaving the caller with a transport error", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("thread-a"), { address: "alpha/design", roleDescription: "Design." });
      x.backend.wait = () => new Promise<void>(() => undefined); // a predecessor that never stops

      await expect(x.core.attachCurrent(caller("thread-b"), { address: "alpha/design" }, AbortSignal.timeout(20)))
        .rejects.toMatchObject({ code: "ATTACH_WAIT_ENDED", message: expect.stringContaining("still running a turn") });

      // Nothing was changed: the lane still belongs to whoever held it.
      expect(x.state.activeBindingForLane("alpha/design")).toMatchObject({ generation: 1, conversationId: "thread-a" });
    } finally { x.database.close(); }
  });

  it("says so plainly when the caller itself went away", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("thread-a"), { address: "alpha/design", roleDescription: "Design." });
      x.backend.wait = () => new Promise<void>(() => undefined);

      await expect(x.core.attachCurrent(caller("thread-b"), { address: "alpha/design" }, AbortSignal.abort(new Error("caller left"))))
        .rejects.toMatchObject({ code: "ATTACH_WAIT_ENDED", message: expect.stringContaining("ended before") });
      expect(x.state.activeBindingForLane("alpha/design")).toMatchObject({ generation: 1 });
    } finally { x.database.close(); }
  });
});
