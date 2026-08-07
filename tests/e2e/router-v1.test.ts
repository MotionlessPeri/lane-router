import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { BackendRegistry, type Notification, type PlatformBackend } from "../../src/router/backend.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { NotificationPump } from "../../src/router/notification-pump.js";
import { RouterCore } from "../../src/router/router-core.js";
import { RouterStateStore } from "../../src/router/state-store.js";
import type { BackendName, BindingRecord } from "../../src/router/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class FakeBackend implements PlatformBackend {
  readonly notifications: Notification[] = [];
  constructor(readonly name: BackendName) {}
  async notifyNormal(_binding: BindingRecord, notification: Notification) { this.notifications.push(notification); return "delivered" as const; }
  async notifyCorrection(_binding: BindingRecord, notification: Notification) { this.notifications.push(notification); return "delivered" as const; }
  async waitUntilReplaceable() {}
  onAttentionOpportunity() { return () => undefined; }
}

function stack(root: string, ids: { value: number }) {
  const database = openRouterDatabase(join(root, "router.sqlite"));
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(root);
  const claude = new FakeBackend("claude");
  const codex = new FakeBackend("codex");
  const backends = new BackendRegistry([claude, codex]);
  const pump = new NotificationPump(state, mailbox, backends);
  const core = new RouterCore({ state, mailbox, backends, pump, newId: (kind) => `${kind}-${++ids.value}`, now: () => ++ids.value });
  return { database, state, mailbox, claude, codex, pump, core };
}

test("V1 coordinates two lanes through durable files, correction history, ack, rotation, and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "lane-router-v1-e2e-")); roots.push(root);
  const ids = { value: 0 };
  const first = stack(root, ids);
  const source = { backend: "codex" as const, conversationId: "thread-source", requestKey: "attach-source" };
  const target = { backend: "claude" as const, conversationId: "session-target", requestKey: "attach-target" };
  try {
    await first.core.attachCurrent(source, { address: "alpha/source", roleDescription: "Coordinates work." });
    await first.core.attachCurrent(target, { address: "alpha/target", roleDescription: "Implements work." });
    expect(first.core.directory("alpha")).toEqual([
      expect.objectContaining({ address: "alpha/source", bound: true }),
      expect.objectContaining({ address: "alpha/target", bound: true }),
    ]);

    const normal = await first.core.send({ ...source, requestKey: "send-normal" }, { target: "alpha/target", kind: "normal", body: "Original task." });
    const correction = await first.core.send({ ...source, requestKey: "send-correction" }, { target: "alpha/target", kind: "correction", replyTo: normal.id, body: "Corrected task." });
    expect(readFileSync(join(root, normal.relativePath), "utf8")).toContain("Original task.");
    expect(readFileSync(join(root, correction.relativePath), "utf8")).toContain(`reply_to: ${normal.id}`);
    await first.core.ack({ ...target, requestKey: "ack-batch" }, { messageIds: [normal.id, correction.id] });
    expect(first.state.requireMessage(normal.id).state).toBe("resolved");

    await first.core.attachCurrent({ backend: "codex", conversationId: "thread-replacement", requestKey: "rotate" }, { address: "alpha/source" });
    await expect(first.core.send({ ...source, requestKey: "stale-send" }, { target: "alpha/target", kind: "normal", body: "stale" }))
      .rejects.toMatchObject({ code: "NOT_ATTACHED" });
    await first.core.send({ backend: "codex", conversationId: "thread-replacement", requestKey: "restart-message" }, { target: "alpha/target", kind: "normal", body: "Survive restart." });
  } finally { first.database.close(); }

  const second = stack(root, ids);
  try {
    expect(second.mailbox.reconcile(second.state)).toEqual({ recovered: 0, moved: 0 });
    await second.pump.onStartup();
    expect(second.claude.notifications).toEqual([expect.objectContaining({ laneAddress: "alpha/target", messageIds: expect.arrayContaining([expect.any(String)]) })]);
    const pending = second.state.pendingMessages("alpha/target");
    expect(pending).toHaveLength(1);
    expect(readFileSync(join(root, pending[0]!.relativePath), "utf8")).toContain("Survive restart.");
  } finally { second.database.close(); }
});
