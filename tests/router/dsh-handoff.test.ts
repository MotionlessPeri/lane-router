import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";

import { DshBackend, DshChannelHub } from "../../src/backends/dsh-backend.js";
import { BackendRegistry, type Notification, type PlatformBackend, type ReachSnapshot } from "../../src/router/backend.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { NotificationPump } from "../../src/router/notification-pump.js";
import { RouterCore } from "../../src/router/router-core.js";
import { RouterStateStore } from "../../src/router/state-store.js";
import type { BindingRecord, CallerContext } from "../../src/router/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const offline: ReachSnapshot = { state: "no_channel", connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null };
const idle: ReachSnapshot = { state: "live", connectedAt: 1, lastLifecycleAt: 2, lastNotifiedAt: null, believedBusy: false };

class HandoffBackend implements PlatformBackend {
  readonly name = "dsh" as const;
  readonly reachBySession = new Map<string, ReachSnapshot>();
  readonly notifications: Notification[] = [];
  async notifyNormal(_binding: BindingRecord, notification: Notification) { this.notifications.push(notification); return "sent" as const; }
  async notifyCorrection(_binding: BindingRecord, notification: Notification) { this.notifications.push(notification); return "sent" as const; }
  async waitUntilReplaceable() {}
  onAttentionOpportunity() { return () => undefined; }
  reach(binding: BindingRecord): ReachSnapshot { return this.reachBySession.get(binding.conversationId) ?? offline; }
  restorePresence() { return "unavailable" as const; }
  resolveIdentity(context: CallerContext) { return { value: context.conversationId, source: "caller" as const }; }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-handoff-")); roots.push(root);
  const database = openRouterDatabase(":memory:");
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(root);
  const backend = new HandoffBackend();
  const pump = new NotificationPump(state, mailbox, new BackendRegistry([backend]));
  let id = 0; let now = 0;
  const core = new RouterCore({ state, mailbox, backends: new BackendRegistry([backend]), pump, newId: (kind) => `${kind}-${++id}`, now: () => ++now });
  const context = (session: string, requestKey = "unused"): CallerContext => ({ backend: "dsh", conversationId: session, requestKey });
  const request = (binding: BindingRecord, successorSessionId = "next") => ({
    address: binding.laneAddress, expectedBindingId: binding.id, expectedGeneration: binding.generation, successorSessionId,
  });
  return { database, core, state, mailbox, backend, pump, context, request };
}

class SessionSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly readyState = this.OPEN;
  readonly frames: unknown[] = [];
  send(value: string, done: (error?: Error) => void): void { this.frames.push(JSON.parse(value)); done(); }
  close(): void { this.emit("close"); }
  lifecycle(state: "idle" | "busy"): void {
    this.emit("message", Buffer.from(JSON.stringify({ protocolVersion: 1, type: "lifecycle", state })));
  }
}

test("real DSH channel hold blocks old handoff, then new channel receives unchanged pending mail", async () => {
  const root = mkdtempSync(join(tmpdir(), "lane-router-handoff-channel-")); roots.push(root);
  const database = openRouterDatabase(":memory:");
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(root);
  const hub = new DshChannelHub((session) => state.activeBindingForConversation("dsh", session));
  const backend = new DshBackend(hub);
  const pump = new NotificationPump(state, mailbox, new BackendRegistry([backend]));
  let id = 0;
  const core = new RouterCore({ state, mailbox, pump, backends: new BackendRegistry([backend]),
    now: () => ++id, newId: (kind) => `${kind}-${++id}` });
  const context = (session: string, requestKey: string): CallerContext => ({ backend: "dsh", conversationId: session, requestKey });
  const oldSocket = new SessionSocket();
  const nextSocket = new SessionSocket();
  try {
    hub.connect("old", oldSocket as unknown as WebSocket);
    hub.connect("next", nextSocket as unknown as WebSocket);
    oldSocket.lifecycle("idle"); nextSocket.lifecycle("idle");
    await core.attachCurrent(context("old", "attach"), { address: "alpha/root", roleDescription: "root" }, undefined, { rejectTakeover: true });
    state.createLane({ address: "alpha/peer", project: "alpha", roleDescription: "peer", now: 5 });
    state.createBinding({ id: "peer-binding", laneAddress: "alpha/peer", backend: "dsh", conversationId: "peer", generation: 1, startup: {}, now: 5 });
    const original = state.activeBindingForLane("alpha/root")!;
    const input = { address: "alpha/root", expectedBindingId: original.id, expectedGeneration: original.generation, successorSessionId: "next" };
    const [first] = await core.send(context("peer", "send-1"), { target: "alpha/root", body: "first", kind: "normal" });
    await expect(core.handoffDsh(context("old", "handoff"), input)).rejects.toMatchObject({ code: "CURRENT_BUSY" });
    expect(state.activeBindingForLane("alpha/root")?.id).toBe(original.id);
    await core.ack(context("old", "ack"), { messageIds: [first!.id] });
    oldSocket.lifecycle("idle");
    oldSocket.close();
    const [second] = await core.send(context("peer", "send-2"), { target: "alpha/root", body: "second", kind: "normal" });
    const result = await core.handoffDsh(context("old", "handoff"), input);
    expect(result.status).toBe("committed");
    expect(nextSocket.frames).toMatchObject([{ notification: { messageIds: [second!.id] } }]);
    expect(state.requireMessage(second!.id).state).toBe("pending");
    expect(core.read(context("next", "read"), { messageIds: [second!.id] })[0]?.body).toBe("second");
    await core.ack(context("next", "ack"), { messageIds: [second!.id] });
    hub.acknowledge("next", [second!.id]);
    expect(backend.reach(state.activeBindingForLane("alpha/root")!).believedBusy).toBe(true);
    nextSocket.lifecycle("idle");
    expect(backend.reach(state.activeBindingForLane("alpha/root")!).believedBusy).toBe(false);
  } finally { hub.close(); database.close(); }
});

test("owner hands off the same lane and mailbox without changing declarations, history or mail", async () => {
  const { database, core, state, backend, context, request } = setup();
  try {
    await core.attachCurrent(context("peer"), { address: "alpha/peer", roleDescription: "peer" });
    await core.attachCurrent(context("old"), { address: "alpha/root", roleDescription: "root", model: "declared-model" });
    const before = state.requireLane("alpha/root");
    const original = state.activeBindingForLane("alpha/root")!;
    const [resolved] = await core.send(context("peer", "send-1"), { target: "alpha/root", body: "resolved", kind: "normal" });
    await core.ack(context("old"), { messageIds: [resolved!.id] });
    const [pending] = await core.send(context("peer", "send-2"), { target: "alpha/root", body: "pending", kind: "correction", replyTo: resolved!.id });
    const beforeMessages = state.allMessages();
    const beforeNotify = backend.notifications.length;
    backend.reachBySession.set("next", idle);

    const result = await core.handoffDsh(context("old"), request(original));
    expect(result).toMatchObject({ status: "committed", address: "alpha/root", laneId: before.id, generation: original.generation + 1, successorSessionId: "next" });
    expect(state.requireLane("alpha/root")).toEqual(before);
    expect(state.activeBindingForLane("alpha/root")).toMatchObject({ id: result.bindingId, backend: "dsh", conversationId: "next", generation: original.generation + 1 });
    expect(state.requireBinding(original.id).inactiveAt).not.toBeNull();
    expect(state.allMessages().map(({ notificationState: _notificationState, ...record }) => record))
      .toEqual(beforeMessages.map(({ notificationState: _notificationState, ...record }) => record));
    expect(state.requireMessage(pending!.id)).toMatchObject({ state: "pending", targetLane: "alpha/root", replyTo: resolved!.id });
    expect(backend.notifications.slice(beforeNotify)).toMatchObject([{ messageIds: [pending!.id] }]);
    expect(() => core.read(context("old"), { messageIds: [pending!.id] })).toThrowError(expect.objectContaining({ code: "NOT_ATTACHED" }));
    await expect(core.ack(context("old"), { messageIds: [pending!.id] })).rejects.toMatchObject({ code: "NOT_ATTACHED" });
    await expect(core.send(context("old", "send-3"), { target: "alpha/peer", body: "forbidden", kind: "normal" })).rejects.toMatchObject({ code: "NOT_ATTACHED" });
    expect(core.read(context("next"), { messageIds: [pending!.id] })[0]?.body).toBe("pending");
    await expect(core.ack(context("next"), { messageIds: [pending!.id] })).resolves.toEqual({ resolved: [pending!.id] });
    await expect(core.ack(context("next"), { messageIds: [pending!.id] })).rejects.toMatchObject({ code: "MESSAGE_NOT_OWNED" });
  } finally { database.close(); }
});

test("an identical uncertain-response retry reports authority without advancing generation or re-notifying", async () => {
  const { database, core, state, backend, context, request } = setup();
  try {
    await core.attachCurrent(context("old"), { address: "alpha/root", roleDescription: "root" });
    const original = state.activeBindingForLane("alpha/root")!;
    backend.reachBySession.set("next", idle);
    const first = await core.handoffDsh(context("old"), request(original));
    const notify = backend.notifications.length;
    backend.reachBySession.delete("next");
    const retry = await core.handoffDsh(context("old"), request(original));
    expect(retry).toEqual({ ...first, status: "already_committed" });
    expect(backend.notifications).toHaveLength(notify);
    expect(state.activeBindingForLane("alpha/root")?.id).toBe(first.bindingId);
    await expect(core.handoffDsh(context("old"), request(original, "different"))).rejects.toMatchObject({ code: "BINDING_CHANGED" });
  } finally { database.close(); }
});

test("post-commit notification failure keeps pending and an exact retry is observational", async () => {
  const { database, core, state, backend, pump, context, request } = setup();
  try {
    await core.attachCurrent(context("peer"), { address: "alpha/peer", roleDescription: "peer" });
    await core.attachCurrent(context("old"), { address: "alpha/root", roleDescription: "root" });
    const [pending] = await core.send(context("peer", "send"), { target: "alpha/root", body: "pending", kind: "normal" });
    const original = state.activeBindingForLane("alpha/root")!;
    backend.reachBySession.set("next", idle);
    const attempt = vi.spyOn(pump, "notifyLane").mockRejectedValueOnce(new Error("notification failed"));
    const first = await core.handoffDsh(context("old"), request(original));
    expect(first.status).toBe("committed");
    expect(state.requireMessage(pending!.id).state).toBe("pending");
    const count = attempt.mock.calls.length;
    await expect(core.handoffDsh(context("old"), request(original))).resolves.toMatchObject({ status: "already_committed", bindingId: first.bindingId });
    expect(attempt.mock.calls).toHaveLength(count);
    attempt.mockRestore();
    await pump.onAttentionOpportunity("alpha/root");
    expect(backend.notifications.at(-1)?.messageIds).toEqual([pending!.id]);
  } finally { database.close(); }
});

test("non-owner, stale expectations, unavailable successor and busy channels fail without writes", async () => {
  const { database, core, state, backend, context, request } = setup();
  try {
    await core.attachCurrent(context("old"), { address: "alpha/root", roleDescription: "root" });
    await core.attachCurrent(context("other"), { address: "alpha/other", roleDescription: "other" });
    const original = state.activeBindingForLane("alpha/root")!;
    const input = request(original);
    backend.reachBySession.set("next", idle);
    await expect(core.handoffDsh(context("unbound"), input)).rejects.toMatchObject({ code: "NOT_BINDING_OWNER" });
    await expect(core.handoffDsh(context("other"), input)).rejects.toMatchObject({ code: "NOT_BINDING_OWNER" });
    await expect(core.handoffDsh(context("old"), { ...input, expectedBindingId: "wrong" })).rejects.toMatchObject({ code: "BINDING_CHANGED" });
    await expect(core.handoffDsh(context("old"), { ...input, expectedGeneration: 99 })).rejects.toMatchObject({ code: "BINDING_CHANGED" });
    await expect(core.handoffDsh(context("old"), { ...input, address: "alpha/other" })).rejects.toMatchObject({ code: "NOT_BINDING_OWNER" });
    await expect(core.handoffDsh(context("old"), request(original, "old"))).rejects.toMatchObject({ code: "SAME_SESSION" });
    backend.reachBySession.delete("next");
    await expect(core.handoffDsh(context("old"), input)).rejects.toMatchObject({ code: "SUCCESSOR_NOT_READY" });
    backend.reachBySession.set("next", { ...idle, state: "unconfirmed", lastLifecycleAt: null });
    await expect(core.handoffDsh(context("old"), input)).rejects.toMatchObject({ code: "SUCCESSOR_NOT_READY" });
    backend.reachBySession.set("next", { ...idle, believedBusy: true });
    await expect(core.handoffDsh(context("old"), input)).rejects.toMatchObject({ code: "SUCCESSOR_NOT_READY" });
    backend.reachBySession.set("next", idle);
    backend.reachBySession.set("old", { ...idle, believedBusy: true });
    await expect(core.handoffDsh(context("old"), input)).rejects.toMatchObject({ code: "CURRENT_BUSY" });
    backend.reachBySession.delete("old");
    await expect(core.handoffDsh(context("old"), request(original, "other"))).rejects.toMatchObject({ code: "SUCCESSOR_ALREADY_BOUND" });
    expect(state.activeBindingForLane("alpha/root")).toEqual(original);
    expect(state.activeBindingForLane("alpha/other")?.conversationId).toBe("other");
  } finally { database.close(); }
});

test("CAS rejects a concurrently changed binding and keeps the competing owner", async () => {
  const { database, core, state, backend, context, request } = setup();
  try {
    await core.attachCurrent(context("old"), { address: "alpha/root", roleDescription: "root" });
    const original = state.activeBindingForLane("alpha/root")!;
    backend.reachBySession.set("next", idle);
    const replace = vi.spyOn(state, "replaceBinding").mockImplementationOnce((input) => {
      replace.mockRestore();
      state.replaceBinding({ expected: original, id: "competitor", laneAddress: original.laneAddress, backend: "dsh", conversationId: "competitor", generation: original.generation + 1, startup: {}, now: 99 });
      return state.replaceBinding(input);
    });
    await expect(core.handoffDsh(context("old"), request(original))).rejects.toMatchObject({ code: "BINDING_CHANGED" });
    expect(state.activeBindingForLane("alpha/root")?.conversationId).toBe("competitor");
  } finally { database.close(); }
});

test("a DSH header cannot transfer a lane held by another backend", async () => {
  const { database, core, state, backend, context } = setup();
  try {
    state.createLane({ address: "alpha/root", project: "alpha", roleDescription: "root", now: 1 });
    const claude = state.createBinding({ id: "claude-binding", laneAddress: "alpha/root", backend: "claude",
      conversationId: "old", generation: 1, startup: {}, now: 2 });
    backend.reachBySession.set("next", idle);
    await expect(core.handoffDsh(context("old"), { address: "alpha/root", expectedBindingId: claude.id,
      expectedGeneration: claude.generation, successorSessionId: "next" })).rejects.toMatchObject({ code: "NOT_BINDING_OWNER" });
    expect(state.activeBindingForLane("alpha/root")).toEqual(claude);
  } finally { database.close(); }
});

test("a uniqueness race rolls the old binding back instead of leaving the lane unbound", async () => {
  const { database, core, state, backend, context, request } = setup();
  try {
    await core.attachCurrent(context("old"), { address: "alpha/root", roleDescription: "root" });
    await core.attachCurrent(context("peer"), { address: "alpha/peer", roleDescription: "peer" });
    const original = state.activeBindingForLane("alpha/root")!;
    backend.reachBySession.set("next", idle);
    const replace = vi.spyOn(state, "replaceBinding").mockImplementationOnce((input) => {
      replace.mockRestore();
      state.replaceBinding({ expected: state.activeBindingForLane("alpha/peer")!, id: "competing-next",
        laneAddress: "alpha/peer", backend: "dsh", conversationId: "next", generation: 2, startup: {}, now: 99 });
      return state.replaceBinding(input);
    });
    await expect(core.handoffDsh(context("old"), request(original))).rejects.toMatchObject({ code: "BINDING_CHANGED" });
    expect(state.activeBindingForLane("alpha/root")).toEqual(original);
    expect(state.activeBindingForLane("alpha/peer")?.conversationId).toBe("next");
  } finally { database.close(); }
});

test("reusing an archived address cannot impersonate the original lane on retry", async () => {
  const { database, core, state, backend, context, request } = setup();
  try {
    await core.attachCurrent(context("old"), { address: "alpha/root", roleDescription: "root" });
    const original = state.activeBindingForLane("alpha/root")!;
    backend.reachBySession.set("next", idle);
    await core.handoffDsh(context("old"), request(original));
    const successor = state.activeBindingForLane("alpha/root")!;
    state.deactivateBinding(successor.id, successor.generation, 50);
    state.archiveLane("alpha/root", 51);
    state.createLane({ address: "alpha/root", project: "alpha", roleDescription: "different lane", now: 52 });
    state.createBinding({ id: "unrelated", laneAddress: "alpha/root", backend: "dsh", conversationId: "next", generation: original.generation + 1, startup: {}, now: 53 });
    await expect(core.handoffDsh(context("old"), request(original))).rejects.toMatchObject({ code: "NOT_BINDING_OWNER" });
    expect(state.activeBindingForLane("alpha/root")?.id).toBe("unrelated");
  } finally { database.close(); }
});

test("ordinary DSH attach still refuses takeover after a handoff", async () => {
  const { database, core, backend, context, state, request } = setup();
  try {
    await core.attachCurrent(context("old"), { address: "alpha/root", roleDescription: "root" }, undefined, { rejectTakeover: true });
    const original = state.activeBindingForLane("alpha/root")!;
    backend.reachBySession.set("next", idle);
    await core.handoffDsh(context("old"), request(original));
    await expect(core.attachCurrent(context("third"), { address: "alpha/root" }, undefined, { rejectTakeover: true }))
      .rejects.toMatchObject({ code: "LANE_ALREADY_BOUND" });
  } finally { database.close(); }
});
