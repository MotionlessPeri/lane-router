import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Notification, NotificationOutcome, PlatformBackend } from "../../src/router/backend.js";
import { BackendRegistry } from "../../src/router/backend.js";
import { openRouterDatabase } from "../../src/router/database.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { NotificationPump } from "../../src/router/notification-pump.js";
import { RouterStateStore } from "../../src/router/state-store.js";
import type { BindingRecord } from "../../src/router/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class RecordingBackend implements PlatformBackend {
  readonly name = "codex" as const;
  readonly normal: Notification[] = [];
  readonly corrections: Notification[] = [];
  outcome: NotificationOutcome = "delivered";
  async notifyNormal(_binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    this.normal.push(notification); return this.outcome;
  }
  async notifyCorrection(_binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    this.corrections.push(notification); return this.outcome;
  }
  async waitUntilReplaceable(): Promise<void> {}
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-pump-"));
  roots.push(root);
  const database = openRouterDatabase(":memory:");
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(root);
  const backend = new RecordingBackend();
  const pump = new NotificationPump(state, mailbox, new BackendRegistry([backend]));
  for (const address of ["alpha/source", "alpha/target"])
    state.createLane({ address, project: "alpha", roleDescription: address, now: 1 });
  state.createBinding({ id: "binding-1", laneAddress: "alpha/target", backend: "codex", conversationId: "target", generation: 1, startup: {}, now: 2 });
  return { database, state, mailbox, backend, pump };
}

function addMessage(x: ReturnType<typeof setup>, id: string, kind: "normal" | "correction", replyTo: string | null = null) {
  const input = { id, requestKey: `request:${id}`, senderLane: "alpha/source", targetLane: "alpha/target", kind, replyTo, createdAt: 10, body: id };
  const file = x.mailbox.writePending(input);
  x.state.insertMessage({ ...input, relativePath: file.relativePath, contentSha256: file.contentSha256 });
}

describe("NotificationPump", () => {
  it("coalesces normal messages and sends corrections individually", async () => {
    const x = setup();
    try {
      addMessage(x, "normal-1", "normal");
      addMessage(x, "normal-2", "normal");
      addMessage(x, "correction-1", "correction", "normal-1");
      await x.pump.notifyLane("alpha/target");
      expect(x.backend.normal).toEqual([expect.objectContaining({ laneAddress: "alpha/target", messageIds: ["normal-1", "normal-2"] })]);
      expect(x.backend.corrections).toEqual([expect.objectContaining({ messageIds: ["correction-1"] })]);
    } finally { x.database.close(); }
  });

  it("keeps deferred and offline messages pending for a later opportunity", async () => {
    const x = setup();
    try {
      addMessage(x, "normal-1", "normal");
      x.backend.outcome = "deferred";
      await x.pump.notifyLane("alpha/target");
      expect(x.state.requireMessage("normal-1").notificationState).toBe("pending");
      x.backend.outcome = "delivered";
      await x.pump.notifyLane("alpha/target");
      expect(x.state.requireMessage("normal-1").notificationState).toBe("notified");
    } finally { x.database.close(); }
  });

  it("retries pending mail on startup, reconnect, and turn-end opportunities", async () => {
    const x = setup();
    try {
      addMessage(x, "normal-1", "normal");
      await x.pump.onStartup();
      await x.pump.onAttentionOpportunity("alpha/target");
      await x.pump.onAttentionOpportunity("alpha/target");
      expect(x.backend.normal).toHaveLength(3);
    } finally { x.database.close(); }
  });

  it("does nothing while a lane is unbound", async () => {
    const x = setup();
    try {
      addMessage(x, "normal-1", "normal");
      x.state.deactivateBinding("binding-1", 1, 20);
      await x.pump.notifyLane("alpha/target");
      expect(x.backend.normal).toHaveLength(0);
    } finally { x.database.close(); }
  });
});
