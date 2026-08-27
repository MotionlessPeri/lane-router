import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NotificationOutcome, PlatformBackend, ReachSnapshot, RestorePresence } from "../../src/router/backend.js";
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
  restoreState: RestorePresence = "online";

  /** Keyed by conversation so one recipient of a copy can be live while another has no channel. */
  readonly outcomes = new Map<string, NotificationOutcome>();
  async notifyNormal(binding: BindingRecord): Promise<NotificationOutcome> {
    this.notified.push(binding);
    return this.outcomes.get(binding.conversationId) ?? "sent";
  }
  async notifyCorrection(binding: BindingRecord): Promise<NotificationOutcome> {
    this.notified.push(binding);
    return this.outcomes.get(binding.conversationId) ?? "sent";
  }
  onAttentionOpportunity(): () => void { return () => undefined; }
  reach(): ReachSnapshot { return this.reachState; }
  restorePresence(): RestorePresence { return this.restoreState; }
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
  const restore = vi.fn(async () => ({ status: "launch_requested" as const }));
  const resolveCwd = vi.fn(async (): Promise<string | null> => null);
  const core = new RouterCore({
    state, mailbox, backends, pump,
    restore: { restore, resolveCwd },
    newId: (kind) => `${kind}-${++sequence}`,
    now: () => ++now,
  });
  return { root, database, state, mailbox, backend, pump, core, restore, resolveCwd };
}

/** Every pending message file under a mailbox root, so an all-or-nothing write can be checked. */
function pendingFileCount(root: string): number {
  let total = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(directory, entry.name));
      else if (directory.replaceAll("\\", "/").endsWith("/pending")) total += 1;
    }
  };
  walk(root);
  return total;
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
        { address: "alpha/design", roleDescription: "Own design.", model: null, backend: null, binding: null, reach: null },
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
        .resolves.toMatchObject([{ senderLane: "alpha/design" }]);
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

  it("stores and refreshes trusted caller cwd without rotating the binding", async () => {
    const x = setup();
    try {
      const first = await x.core.attachCurrent({ ...caller("thread-a"), cwd: "D:\\project-a" }, {
        address: "alpha/design", roleDescription: "Design.",
      });
      // The cwd column is the single home for a conversation's directory; startup stays free of it.
      expect(first.binding.cwd).toBe("D:\\project-a");
      expect(first.binding.startup).toEqual({});

      x.state.createLane({ address: "alpha/target", project: "alpha", roleDescription: "Target.", now: 1 });
      await x.core.send({ ...caller("thread-a", "send:refresh"), cwd: "D:\\project-b" }, {
        target: "alpha/target", body: "refresh", kind: "normal",
      });

      expect(x.state.activeBindingForLane("alpha/design")).toMatchObject({
        id: first.binding.id, generation: first.binding.generation, cwd: "D:\\project-b",
      });
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

describe("RouterCore project restore", () => {
  it("derives the project and reports current, inactive, and restored lanes in directory order", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("thread-main"), { address: "alpha/main", roleDescription: "Main." });
      x.state.createLane({ address: "alpha/inactive", project: "alpha", roleDescription: "Inactive.", now: 1 });
      x.state.createLane({ address: "alpha/peer", project: "alpha", roleDescription: "Peer.", now: 1 });
      x.state.createBinding({ id: "binding-peer", laneAddress: "alpha/peer", backend: "codex", conversationId: "thread-peer", generation: 1, startup: {}, now: 2 });

      await expect(x.core.restoreProject(caller("thread-main", "restore:1"), {})).resolves.toEqual({
        project: "alpha",
        results: [
          { address: "alpha/inactive", status: "skipped_inactive" },
          { address: "alpha/main", status: "skipped_current" },
          { address: "alpha/peer", status: "launch_requested" },
        ],
      });
      expect(x.restore).toHaveBeenCalledOnce();
    } finally { x.database.close(); }
  });

  it("validates an explicit subset completely before launching anything", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("thread-main"), { address: "alpha/main", roleDescription: "Main." });
      x.state.createLane({ address: "alpha/peer", project: "alpha", roleDescription: "Peer.", now: 1 });
      x.state.createBinding({ id: "binding-peer", laneAddress: "alpha/peer", backend: "codex", conversationId: "thread-peer", generation: 1, startup: {}, now: 2 });
      await expect(x.core.restoreProject(caller("thread-main", "restore:bad"), {
        lanes: ["alpha/peer", "beta/foreign"],
      })).rejects.toMatchObject({ code: "RESTORE_LANE_OUTSIDE_PROJECT" });
      expect(x.restore).not.toHaveBeenCalled();
    } finally { x.database.close(); }
  });

  it("isolates one restore failure and preserves every binding generation", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("thread-main"), { address: "alpha/main", roleDescription: "Main." });
      for (const name of ["a", "b"]) {
        x.state.createLane({ address: `alpha/${name}`, project: "alpha", roleDescription: name, now: 1 });
        x.state.createBinding({ id: `binding-${name}`, laneAddress: `alpha/${name}`, backend: "codex", conversationId: `thread-${name}`, generation: 7, startup: {}, now: 2 });
      }
      x.restore.mockImplementation(async (binding) => {
        if (binding.laneAddress === "alpha/a") throw new Error("boom");
        return { status: "launch_requested" };
      });
      const result = await x.core.restoreProject(caller("thread-main", "restore:mixed"), { lanes: ["alpha/a", "alpha/b"] });
      expect(result.results).toEqual([
        { address: "alpha/a", status: "failed", reason: "terminal_launch_failed", message: "boom" },
        { address: "alpha/b", status: "launch_requested" },
      ]);
      expect(x.state.activeBindingForLane("alpha/a")?.generation).toBe(7);
      expect(x.state.activeBindingForLane("alpha/b")?.generation).toBe(7);
    } finally { x.database.close(); }
  });
});

describe("declared model", () => {
  it("records a declaration on create, replaces it on request, and never clears it by omission", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("first"), { address: "alpha/design", roleDescription: "design", model: "claude-opus-5" });
      expect(x.state.requireLane("alpha/design").model).toBe("claude-opus-5");

      // Re-attaching to say something about the role must leave the model alone: the two are
      // separate facts, and attach is the tool people call to edit either one.
      await x.core.attachCurrent(caller("first"), { address: "alpha/design", roleDescription: "design, revised" });
      expect(x.state.requireLane("alpha/design")).toMatchObject({ roleDescription: "design, revised", model: "claude-opus-5" });

      await x.core.attachCurrent(caller("first"), { address: "alpha/design", model: "sonnet" });
      expect(x.state.requireLane("alpha/design").model).toBe("sonnet");

      // A lane that declares nothing stays null rather than acquiring some default here.
      await x.core.attachCurrent(caller("second", "attach:second"), { address: "alpha/plain", roleDescription: "plain" });
      expect(x.state.requireLane("alpha/plain").model).toBeNull();
    } finally { x.database.close(); }
  });

  it("reports the declaration through both query surfaces the launchers read", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("first"), { address: "alpha/design", roleDescription: "design", model: "claude-opus-5" });
      await x.core.attachCurrent(caller("second", "attach:second"), { address: "alpha/plain", roleDescription: "plain" });

      // rotate reads the directory it already fetches for the window title; open reads
      // resume-info. Both have to carry it, or one of the three entry points goes blind.
      expect(x.core.directory("alpha").map((entry) => [entry.address, entry.model]))
        .toEqual([["alpha/design", "claude-opus-5"], ["alpha/plain", null]]);
      await expect(x.core.resumeInfo("alpha/design")).resolves.toMatchObject({ state: "bound", model: "claude-opus-5" });
      await expect(x.core.resumeInfo("alpha/plain")).resolves.toMatchObject({ state: "bound", model: null });
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
      const [sent] = await x.core.send(caller("source", "send:1"), input);
      const [retried] = await x.core.send(caller("source", "send:1"), input);
      expect(retried!.id).toBe(sent!.id);
      expect(x.state.allMessages()).toHaveLength(1);
      expect(readFileSync(join(x.root, sent!.relativePath), "utf8")).toContain("Do the work.");
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
      const [first] = await x.core.send(caller("source", "send:1"), { target: "alpha/target", body: "One", kind: "normal" });
      const [second] = await x.core.send(caller("source", "send:2"), { target: "alpha/target", body: "Two", kind: "normal" });
      await expect(x.core.ack(caller("source", "ack:wrong"), { messageIds: [first!.id] }))
        .rejects.toMatchObject({ code: "MESSAGE_NOT_OWNED" });
      const result = await x.core.ack(caller("target", "ack:target"), { messageIds: [first!.id, second!.id] });
      expect(result.resolved).toEqual([first!.id, second!.id]);
      expect(x.state.requireMessage(first!.id)).toEqual(expect.objectContaining({ state: "resolved", ackGeneration: 1 }));
      expect(join(x.root, x.state.requireMessage(first!.id).relativePath).replaceAll("\\", "/")).toContain("/resolved/");
    } finally { x.database.close(); }
  });

  it("delivers a carbon copy each recipient owns and acks on its own", async () => {
    const x = setup();
    try {
      for (const lane of ["source", "hub", "render", "ui"]) {
        await x.core.attachCurrent(caller(lane, `attach:${lane}`), { address: `alpha/${lane}`, roleDescription: `${lane}.` });
      }
      const copies = await x.core.send(caller("source", "send:cc"), {
        target: "alpha/hub", cc: ["alpha/render", "alpha/ui"], body: "Three decisions.", kind: "normal",
      });

      expect(copies.map((copy) => copy.targetLane)).toEqual(["alpha/hub", "alpha/render", "alpha/ui"]);
      expect(new Set(copies.map((copy) => copy.id)).size).toBe(3);
      for (const copy of copies) {
        expect(readFileSync(join(x.root, copy.relativePath), "utf8")).toContain("Three decisions.");
      }

      // Independent lifecycles: one recipient acking must leave the other copies untouched,
      // which is the whole reason a copy is a message rather than a second target on one row.
      await x.core.ack(caller("render", "ack:render"), { messageIds: [copies[1]!.id] });
      expect(x.state.requireMessage(copies[1]!.id).state).toBe("resolved");
      expect(x.state.requireMessage(copies[0]!.id).state).toBe("pending");
      expect(x.state.requireMessage(copies[2]!.id).state).toBe("pending");
      await expect(x.core.ack(caller("ui", "ack:wrong"), { messageIds: [copies[0]!.id] }))
        .rejects.toMatchObject({ code: "MESSAGE_NOT_OWNED" });
    } finally { x.database.close(); }
  });

  it("names every recipient in each copy, and writes nothing when one of them is unknown", async () => {
    const x = setup();
    try {
      for (const lane of ["source", "hub", "render"]) {
        await x.core.attachCurrent(caller(lane, `attach:${lane}`), { address: `alpha/${lane}`, roleDescription: `${lane}.` });
      }
      const copies = await x.core.send(caller("source", "send:cc"), {
        target: "alpha/hub", cc: ["alpha/render"], body: "Body.", kind: "normal",
      });
      for (const copy of copies) {
        expect(readFileSync(join(x.root, copy.relativePath), "utf8")).toContain("cc: alpha/hub, alpha/render");
      }

      // All or nothing. Counting both sides matters: counting rows alone would miss a half state
      // where a file was written and its row was not.
      const before = { rows: x.state.allMessages().length, files: pendingFileCount(x.root) };
      await expect(x.core.send(caller("source", "send:bad"), {
        target: "alpha/hub", cc: ["alpha/render", "alpha/nobody"], body: "Body.", kind: "normal",
      })).rejects.toMatchObject({ code: "LANE_NOT_FOUND" });
      expect({ rows: x.state.allMessages().length, files: pendingFileCount(x.root) }).toEqual(before);
    } finally { x.database.close(); }
  });

  it("replays a carbon copy without duplicating any of it", async () => {
    const x = setup();
    try {
      for (const lane of ["source", "hub", "render"]) {
        await x.core.attachCurrent(caller(lane, `attach:${lane}`), { address: `alpha/${lane}`, roleDescription: `${lane}.` });
      }
      const first = await x.core.send(caller("source", "send:cc"), {
        target: "alpha/hub", cc: ["alpha/render"], body: "Body.", kind: "normal",
      });
      const replay = await x.core.send(caller("source", "send:cc"), {
        target: "alpha/hub", cc: ["alpha/render"], body: "Body.", kind: "normal",
      });
      expect(replay.map((copy) => copy.id)).toEqual(first.map((copy) => copy.id));
      expect(x.state.allMessages()).toHaveLength(2);

      // A replay naming the recipients the other way round is still the same call, and must still
      // be free. Honest limit: this does not tell an address-derived key from an index-derived one.
      // A real retry re-sends the identical body, so the order never actually differs, and both
      // forms survive this - measured, not assumed. The address form is chosen for being
      // order-independent by construction, not because anyone has hit the other one.
      const reordered = await x.core.send(caller("source", "send:cc"), {
        target: "alpha/render", cc: ["alpha/hub"], body: "Body.", kind: "normal",
      });
      const byTarget = (copies: readonly { targetLane: string; id: string }[]) =>
        Object.fromEntries(copies.map((copy) => [copy.targetLane, copy.id]));
      expect(byTarget(reordered)).toEqual(byTarget(first));
      expect(x.state.allMessages()).toHaveLength(2);
    } finally { x.database.close(); }
  });

  it("reports what the notification actually did, per recipient", async () => {
    const x = setup();
    try {
      for (const lane of ["source", "hub", "render"]) {
        await x.core.attachCurrent(caller(lane, `attach:${lane}`), { address: `alpha/${lane}`, roleDescription: `${lane}.` });
      }
      x.backend.outcomes.set("render", "no_channel");

      const copies = await x.core.send(caller("source", "send:cc"), {
        target: "alpha/hub", cc: ["alpha/render"], body: "Body.", kind: "normal",
      });

      // Returning the row captured before notifyLane makes both of these read `pending`, which is
      // exactly how "nobody was reachable" used to look identical to "delivered".
      expect(copies.map((copy) => [copy.targetLane, copy.notificationState])).toEqual([
        ["alpha/hub", "sent"],
        ["alpha/render", "no_channel"],
      ]);
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

describe("resume info", () => {
  it("reports the facts a resume needs for a bound lane", async () => {
    const x = setup();
    try {
      await x.core.attachCurrent(caller("thread-1"), { address: "alpha/design", roleDescription: "design" });
      x.state.updateBindingCwd("codex", "thread-1", "E:\\project");
      x.backend.reachState = { state: "unconfirmed", connectedAt: 10, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null };
      x.backend.restoreState = "offline";
      await expect(x.core.resumeInfo("alpha/design")).resolves.toEqual({
        state: "bound", backend: "codex", conversationId: "thread-1", cwd: "E:\\project",
        generation: 1, reach: x.backend.reachState, restorePresence: "offline", model: null,
      });
    } finally { x.database.close(); }
  });

  it("distinguishes a missing lane from an unbound one and rejects malformed addresses", async () => {
    const x = setup();
    try {
      await expect(x.core.resumeInfo("alpha/ghost")).resolves.toEqual({ state: "missing" });
      await x.core.attachCurrent(caller("thread-1"), { address: "alpha/design", roleDescription: "design" });
      const binding = x.state.activeBindingForLane("alpha/design");
      if (!binding) throw new Error("expected an active binding");
      x.state.deactivateBinding(binding.id, binding.generation, 50);
      await expect(x.core.resumeInfo("alpha/design")).resolves.toEqual({ state: "unbound" });
      await expect(x.core.resumeInfo("not-an-address")).rejects.toThrow(/invalid lane address/iu);
    } finally { x.database.close(); }
  });

  it("falls back to legacy startup metadata and then to the restorer's resolver", async () => {
    const x = setup();
    try {
      x.state.createLane({ address: "alpha/legacy", project: "alpha", roleDescription: "legacy", now: 1 });
      x.state.createBinding({
        id: "binding-legacy", laneAddress: "alpha/legacy", backend: "codex",
        conversationId: "thread-legacy", generation: 2, startup: { cwd: "D:\\written-by-old-build" }, now: 2,
      });
      await expect(x.core.resumeInfo("alpha/legacy")).resolves.toMatchObject({ cwd: "D:\\written-by-old-build" });

      x.state.createLane({ address: "alpha/blank", project: "alpha", roleDescription: "blank", now: 3 });
      x.state.createBinding({
        id: "binding-blank", laneAddress: "alpha/blank", backend: "codex",
        conversationId: "thread-blank", generation: 1, startup: {}, now: 4,
      });
      x.resolveCwd.mockResolvedValueOnce("E:\\located");
      await expect(x.core.resumeInfo("alpha/blank")).resolves.toMatchObject({ cwd: "E:\\located" });
      // A resolver that finds nothing leaves the fact honest: null, never a guess.
      x.resolveCwd.mockResolvedValueOnce(null);
      await expect(x.core.resumeInfo("alpha/blank")).resolves.toMatchObject({ cwd: null });
    } finally { x.database.close(); }
  });
});
