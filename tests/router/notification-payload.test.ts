import { describe, expect, it, vi } from "vitest";

import { CodexBackend } from "../../src/backends/codex-backend.js";
import { connectClaudeChannel } from "../../src/process/local-client.js";
import { LocalRouterServer } from "../../src/process/local-server.js";
import type { Notification } from "../../src/router/backend.js";
import { notificationPayload } from "../../src/router/notification-payload.js";
import type { BindingRecord } from "../../src/router/types.js";

const notification: Notification = {
  laneAddress: "alpha/design",
  pendingPath: "C:/mailboxes/alpha/design/pending",
  kind: "normal",
  messageIds: ["message-1", "message-2"],
  messages: [
    { id: "message-1", sender: "alpha/hub", summary: "本轮 lane 重构的顺序" },
    { id: "message-2", sender: "beta/impl", summary: "退役前先关窗口" },
  ],
};

/** How the four fields were serialised before summaries existed, byte for byte. */
const legacy = JSON.stringify({
  kind: "lane_router_mailbox",
  laneAddress: notification.laneAddress,
  pendingPath: notification.pendingPath,
  messageIds: notification.messageIds,
});

describe("notificationPayload", () => {
  // Acceptance 1 + 2: one entry per message, each naming its own sender rather than a single
  // sender for the batch — a coalesced notification can carry mail from several lanes.
  it("names every message it covers with that message's own sender", () => {
    expect(JSON.parse(notificationPayload(notification))).toMatchObject({
      messages: [
        { id: "message-1", sender: "alpha/hub", summary: "本轮 lane 重构的顺序" },
        { id: "message-2", sender: "beta/impl", summary: "退役前先关窗口" },
      ],
    });
  });

  // Acceptance 6. Asserting the four field names are still present would pass even with the new
  // data smuggled inside `messageIds`, so this asserts the old bytes still open the payload:
  // same fields, same values, same order, with everything new appended after them.
  it("opens with the four existing fields exactly as they were serialised before", () => {
    const payload = notificationPayload(notification);
    expect(payload.slice(0, legacy.length - 1)).toBe(legacy.slice(0, -1));
    expect(payload[legacy.length - 1]).toBe(",");
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect({
      kind: parsed.kind, laneAddress: parsed.laneAddress,
      pendingPath: parsed.pendingPath, messageIds: parsed.messageIds,
    }).toEqual(JSON.parse(legacy));
  });

  // Acceptance 4. The envelope `kind` is a constant, so before this field a correction was
  // indistinguishable from ordinary mail — the one class of message that most needs to be.
  it("says whether the mail is ordinary or a correction", () => {
    expect(JSON.parse(notificationPayload(notification))).toMatchObject({
      kind: "lane_router_mailbox", messageKind: "normal",
    });
    expect(JSON.parse(notificationPayload({ ...notification, kind: "correction" })))
      .toMatchObject({ kind: "lane_router_mailbox", messageKind: "correction" });
  });
});

// Acceptance 7. Not "both look right" but "both are the same string": the Claude payload is built
// in the client process from a frame that crossed a socket, so a field can be correct at the pump
// and still not arrive. Driving both real paths is what makes that visible.
it("produces byte-identical payloads on the Claude and the Codex path", async () => {
  const binding: BindingRecord = {
    id: "binding-1", laneAddress: "alpha/design", backend: "claude", conversationId: "session-1",
    generation: 1, startup: {}, activeAt: 1, inactiveAt: null, cwd: null,
  };
  const request = vi.fn(async (method: string) => {
    if (method === "thread/read") return { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } };
    if (method === "turn/start") return { turn: { id: "turn-new", status: "inProgress", items: [] } };
    throw new Error(`unexpected request: ${method}`);
  });
  const codex = new CodexBackend({
    client: { request, isConnected: () => true, onNotification: () => () => undefined },
    resolveLane: () => "alpha/design",
  });
  await expect(codex.notifyNormal({ ...binding, backend: "codex", conversationId: "thread-1" }, notification)).resolves.toBe("sent");
  const codexPayload = (request.mock.calls[1]![1] as { input: Array<{ text: string }> }).input[0]!.text;

  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex: { endpoint: "ws://127.0.0.1:1" } as never, instanceId: "x" });
  const discovery = await server.start();
  const channel = await connectClaudeChannel(async () => discovery.url, "session-1");
  const claudePayloads: string[] = [];
  channel.attach({ notification: async (value) => { claudePayloads.push(value.params.content); } });
  try {
    await expect(server.claude.notify(binding, notification)).resolves.toBe("sent");
    await vi.waitFor(() => expect(claudePayloads).toHaveLength(1));
    expect(claudePayloads[0]).toBe(codexPayload);
    expect(JSON.parse(codexPayload)).toMatchObject({ messages: [{ sender: "alpha/hub" }, { sender: "beta/impl" }] });
  } finally { await channel.close(); await server.close(); }
});
