import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Notification, NotificationOutcome, PlatformBackend, ReachSnapshot } from "../../src/router/backend.js";
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
  outcome: NotificationOutcome = "sent";
  async notifyNormal(_binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    this.normal.push(notification); return this.outcome;
  }
  async notifyCorrection(_binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    this.corrections.push(notification); return this.outcome;
  }
  onAttentionOpportunity(): () => void { return () => undefined; }
  async waitUntilReplaceable(): Promise<void> {}
  reach(): ReachSnapshot {
    return { state: "live", connectedAt: 1, lastLifecycleAt: 2, lastNotifiedAt: 3, believedBusy: false };
  }
  resolveIdentity(context: { conversationId: string }) {
    return { value: context.conversationId, source: "caller" as const };
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lane-router-pump-"));
  roots.push(root);
  const database = openRouterDatabase(":memory:");
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(root);
  const backend = new RecordingBackend();
  const pump = new NotificationPump(state, mailbox, new BackendRegistry([backend]));
  for (const address of ["alpha/source", "alpha/hub", "alpha/target"])
    state.createLane({ address, project: "alpha", roleDescription: address, now: 1 });
  state.createBinding({ id: "binding-1", laneAddress: "alpha/target", backend: "codex", conversationId: "target", generation: 1, startup: {}, now: 2 });
  return { root, database, state, mailbox, backend, pump };
}

function addMessage(
  x: ReturnType<typeof setup>, id: string, kind: "normal" | "correction", replyTo: string | null = null,
  options: { sender?: string; body?: string } = {},
) {
  const input = {
    id, requestKey: `request:${id}`, senderLane: options.sender ?? "alpha/source", targetLane: "alpha/target",
    kind, replyTo, createdAt: 10, body: options.body ?? id,
  };
  const file = x.mailbox.writePending(input);
  x.state.insertMessage({ ...input, relativePath: file.relativePath, contentSha256: file.contentSha256 });
}

function messageFile(x: ReturnType<typeof setup>, id: string): string {
  return join(x.root, x.state.requireMessage(id).relativePath);
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

  it("records every outcome as itself rather than leaving the undelivered ones indistinguishable", async () => {
    const x = setup();
    try {
      addMessage(x, "normal-1", "normal");
      // Before any attempt, 'pending' means exactly that: nothing has been tried yet.
      expect(x.state.requireMessage("normal-1").notificationState).toBe("pending");
      for (const outcome of ["deferred", "no_channel", "send_failed", "sent"] as const) {
        x.backend.outcome = outcome;
        await x.pump.notifyLane("alpha/target");
        expect(x.state.requireMessage("normal-1").notificationState).toBe(outcome);
      }
    } finally { x.database.close(); }
  });

  it("keeps an undelivered message eligible for a later opportunity", async () => {
    const x = setup();
    try {
      addMessage(x, "normal-1", "normal");
      x.backend.outcome = "no_channel";
      await x.pump.notifyLane("alpha/target");
      expect(x.state.requireMessage("normal-1").state).toBe("pending");
      x.backend.outcome = "sent";
      await x.pump.notifyLane("alpha/target");
      expect(x.backend.normal).toHaveLength(2);
    } finally { x.database.close(); }
  });

  // Acceptance criterion: the recorded outcome is observational. Which messages a notification
  // covers must not depend on it, or changing the vocabulary would have changed delivery.
  it("selects the same messages whatever outcome was recorded before", async () => {
    for (const previous of ["pending", "sent", "deferred", "no_channel", "send_failed"] as const) {
      const x = setup();
      try {
        addMessage(x, "normal-1", "normal");
        addMessage(x, "normal-2", "normal");
        x.state.recordNotificationOutcome(["normal-1"], previous === "pending" ? "sent" : previous);
        if (previous === "pending") x.database.prepare("UPDATE message SET notification_state='pending'").run();
        x.backend.outcome = "sent";
        await x.pump.notifyLane("alpha/target");
        expect(x.backend.normal.at(-1)?.messageIds).toEqual(["normal-1", "normal-2"]);
      } finally { x.database.close(); }
    }
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

  // Acceptance 1 + 2 + 3. One notification stands for every pending message of a lane, and those
  // can come from different lanes, so the sender belongs to each entry rather than to the batch.
  it("names each covered message with its own sender and the first line of its body", async () => {
    const x = setup();
    try {
      addMessage(x, "normal-1", "normal", null, { sender: "alpha/source", body: "退役前先关窗口，未读信也会拦\n\n第二段不该出现在通知里" });
      addMessage(x, "normal-2", "normal", null, { sender: "alpha/hub", body: "\n\n  本轮 lane 重构的顺序  \n更多细节在正文" });
      await x.pump.notifyLane("alpha/target");
      expect(x.backend.normal).toHaveLength(1);
      expect(x.backend.normal[0]!.messages).toEqual([
        { id: "normal-1", sender: "alpha/source", summary: "退役前先关窗口，未读信也会拦" },
        { id: "normal-2", sender: "alpha/hub", summary: "本轮 lane 重构的顺序" },
      ]);
    } finally { x.database.close(); }
  });

  // Acceptance 3, the two ends of it. The summary shares one CLI line with the rest of the
  // payload, so a long first line is cut; a message with nothing to summarise says so with an
  // empty string rather than with something invented.
  it("cuts an over-long first line and leaves an empty body without a summary", async () => {
    const x = setup();
    try {
      addMessage(x, "normal-1", "normal", null, { body: "x".repeat(200) });
      addMessage(x, "normal-2", "normal", null, { body: "y".repeat(80) });
      addMessage(x, "normal-3", "normal", null, { body: "" });
      await x.pump.notifyLane("alpha/target");
      const summaries = x.backend.normal[0]!.messages.map((message) => message.summary);
      expect(summaries[0]).toBe(`${"x".repeat(79)}…`);
      // Exactly at the limit is not over it: cutting here would prove the truncation fires on
      // length rather than on excess.
      expect(summaries[1]).toBe("y".repeat(80));
      expect(summaries[2]).toBe("");
    } finally { x.database.close(); }
  });

  // Acceptance 5. Reading bodies is the only part of a notification that touches the filesystem,
  // so it is the only part that can fail on its own. A lane that cannot be woken is a worse fault
  // than one woken without a summary, so an unreadable file costs its own summary and nothing else.
  it("still wakes the lane when a message file is missing or corrupt", async () => {
    const x = setup();
    try {
      addMessage(x, "normal-1", "normal", null, { body: "这封的文件还在" });
      addMessage(x, "normal-2", "normal", null, { body: "这封的文件会被删掉" });
      addMessage(x, "normal-3", "normal", null, { body: "这封的文件会被写坏" });
      rmSync(messageFile(x, "normal-2"));
      writeFileSync(messageFile(x, "normal-3"), "no header at all", "utf8");

      await x.pump.notifyLane("alpha/target");
      expect(x.backend.normal).toHaveLength(1);
      expect(x.backend.normal[0]!.messageIds).toEqual(["normal-1", "normal-2", "normal-3"]);
      expect(x.backend.normal[0]!.messages.map((message) => message.summary)).toEqual(["这封的文件还在", "", ""]);
      expect(x.backend.normal[0]!.messages.map((message) => message.sender)).toEqual(["alpha/source", "alpha/source", "alpha/source"]);
      // Acceptance 8: the delivery verdict is what it would have been with every file intact.
      for (const id of ["normal-1", "normal-2", "normal-3"]) expect(x.state.requireMessage(id).notificationState).toBe("sent");
    } finally { x.database.close(); }
  });

  // Acceptance 4 on this side of the wire: a correction stands for exactly one message, and the
  // notification says which and from whom.
  it("describes a correction with the single message it stands for", async () => {
    const x = setup();
    try {
      addMessage(x, "normal-1", "normal");
      addMessage(x, "correction-1", "correction", "normal-1", { sender: "alpha/hub", body: "上一封的第三点写反了" });
      await x.pump.notifyLane("alpha/target");
      expect(x.backend.corrections).toHaveLength(1);
      expect(x.backend.corrections[0]!.kind).toBe("correction");
      expect(x.backend.corrections[0]!.messages).toEqual([
        { id: "correction-1", sender: "alpha/hub", summary: "上一封的第三点写反了" },
      ]);
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
