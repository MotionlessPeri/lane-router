import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { BackendRegistry, type Notification, type PlatformBackend, type ReachSnapshot } from "../../src/router/backend.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { NotificationPump } from "../../src/router/notification-pump.js";
import { RouterCore } from "../../src/router/router-core.js";
import { RouterStateStore } from "../../src/router/state-store.js";
import type { BindingRecord, CallerContext } from "../../src/router/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class OfflineDshBackend implements PlatformBackend {
  readonly name = "dsh" as const;
  readonly notifications: Notification[] = [];
  async notifyNormal(_binding: BindingRecord, notification: Notification) { this.notifications.push(notification); return "no_channel" as const; }
  async notifyCorrection(_binding: BindingRecord, notification: Notification) { this.notifications.push(notification); return "no_channel" as const; }
  async waitUntilReplaceable() {}
  onAttentionOpportunity() { return () => undefined; }
  reach(): ReachSnapshot { return { state: "no_channel", connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null }; }
  restorePresence() { return "unavailable" as const; }
  resolveIdentity(context: CallerContext) { return { value: context.conversationId, source: "caller" as const }; }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-dsh-")); roots.push(root);
  const database = openRouterDatabase(":memory:");
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(root);
  const backend = new OfflineDshBackend();
  const backends = new BackendRegistry([backend]);
  const pump = new NotificationPump(state, mailbox, backends);
  let id = 0; let now = 0;
  const core = new RouterCore({ state, mailbox, backends, pump, newId: (kind) => `${kind}-${++id}`, now: () => ++now });
  const context = (session: string, requestKey: string): CallerContext => ({ backend: "dsh", conversationId: session, requestKey });
  return { root, database, state, mailbox, backend, core, context };
}

test("DSH attach is same-session idempotent and fail-closed against takeover", async () => {
  const { database, core, context } = setup();
  try {
    const first = await core.attachCurrent(context("s1", "a1"), { address: "alpha/worker", roleDescription: "worker" }, undefined, { rejectTakeover: true });
    const again = await core.attachCurrent(context("s1", "a2"), { address: "alpha/worker" }, undefined, { rejectTakeover: true });
    expect(again.generation).toBe(first.generation);
    await expect(core.attachCurrent(context("s2", "a3"), { address: "alpha/worker" }, undefined, { rejectTakeover: true }))
      .rejects.toMatchObject({ code: "LANE_ALREADY_BOUND" });
  } finally { database.close(); }
});

test("DSH structured read preflights the whole batch, leaves offline mail pending, and ack is non-idempotent", async () => {
  const { database, core, state, mailbox, context } = setup();
  try {
    await core.attachCurrent(context("sender", "a1"), { address: "alpha/sender", roleDescription: "sender" });
    await core.attachCurrent(context("receiver", "a2"), { address: "alpha/receiver", roleDescription: "receiver" });
    await core.attachCurrent(context("other", "a3"), { address: "alpha/other", roleDescription: "other" });
    const [owned] = await core.send(context("sender", "send-1"), { target: "alpha/receiver", body: "structured body", kind: "normal" });
    const [foreign] = await core.send(context("sender", "send-2"), { target: "alpha/other", body: "secret", kind: "normal" });
    expect(state.requireMessage(owned!.id)).toMatchObject({ state: "pending", notificationState: "no_channel" });

    const readBody = vi.spyOn(mailbox, "readBody");
    expect(() => core.read(context("receiver", "read-1"), { messageIds: [owned!.id, foreign!.id] }))
      .toThrowError(expect.objectContaining({ code: "MESSAGE_NOT_OWNED" }));
    expect(readBody).not.toHaveBeenCalled();
    expect(core.read(context("receiver", "read-2"), { messageIds: [owned!.id] })).toEqual([{
      id: owned!.id, sender: "alpha/sender", target: "alpha/receiver", kind: "normal", replyTo: null,
      createdAt: owned!.createdAt, body: "structured body",
    }]);
    await expect(core.ack(context("receiver", "ack-1"), { messageIds: [owned!.id] })).resolves.toEqual({ resolved: [owned!.id] });
    await expect(core.ack(context("receiver", "ack-2"), { messageIds: [owned!.id] })).rejects.toMatchObject({ code: "MESSAGE_NOT_OWNED" });
  } finally { database.close(); }
});

test("ack leaves every row pending when a mailbox file is predictably missing", async () => {
  const { root, database, core, state, context } = setup();
  try {
    await core.attachCurrent(context("sender", "a1"), { address: "alpha/sender", roleDescription: "sender" });
    await core.attachCurrent(context("receiver", "a2"), { address: "alpha/receiver", roleDescription: "receiver" });
    const [first] = await core.send(context("sender", "send-1"), { target: "alpha/receiver", body: "one", kind: "normal" });
    const [missing] = await core.send(context("sender", "send-2"), { target: "alpha/receiver", body: "two", kind: "normal" });
    rmSync(join(root, state.requireMessage(missing!.id).relativePath));
    await expect(core.ack(context("receiver", "ack"), { messageIds: [first!.id, missing!.id] })).rejects.toThrow(/missing/i);
    expect(state.requireMessage(first!.id).state).toBe("pending");
    expect(state.requireMessage(missing!.id).state).toBe("pending");
  } finally { database.close(); }
});

test("an old DSH session loses read ownership after its binding generation is replaced", async () => {
  const { database, core, state, context } = setup();
  try {
    await core.attachCurrent(context("sender", "a1"), { address: "alpha/sender", roleDescription: "sender" });
    const attached = await core.attachCurrent(context("old", "a2"), { address: "alpha/receiver", roleDescription: "receiver" });
    const [message] = await core.send(context("sender", "send"), { target: "alpha/receiver", body: "pending", kind: "normal" });
    const old = state.activeBindingForConversation("dsh", "old")!;
    state.replaceBinding({ expected: old, id: "replacement", laneAddress: old.laneAddress, backend: "dsh", conversationId: "new", generation: attached.generation + 1, startup: {}, now: 99 });
    expect(() => core.read(context("old", "read"), { messageIds: [message!.id] })).toThrowError(expect.objectContaining({ code: "NOT_ATTACHED" }));
  } finally { database.close(); }
});
