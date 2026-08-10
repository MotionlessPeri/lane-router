import type { WebSocket } from "ws";
import { expect, test, vi } from "vitest";

import { ClaudeChannelHub } from "../../src/process/local-server.js";
import type { BindingRecord } from "../../src/router/types.js";

function binding(conversationId: string): BindingRecord {
  return {
    id: `binding-${conversationId}`,
    laneAddress: "alpha/design",
    backend: "claude",
    conversationId,
    generation: 1,
    startup: {},
    activeAt: 1,
    inactiveAt: null,
  };
}

function fakeSocket(): WebSocket {
  return { on: vi.fn(), close: vi.fn(), send: vi.fn(), readyState: 1, OPEN: 1 } as unknown as WebSocket;
}

/** A socket whose send actually completes, so notify() can run to the end. */
function sendableSocket(): WebSocket & { readyState: number } {
  return {
    on: vi.fn(), close: vi.fn(), readyState: 1, OPEN: 1,
    send: vi.fn((_value: string, callback: (error?: Error) => void) => callback()),
  } as unknown as WebSocket & { readyState: number };
}

const notification = {
  laneAddress: "alpha/design", pendingPath: "C:/mailbox/pending",
  kind: "normal" as const, messageIds: ["message-1"],
};

/** A clock the test drives, so timestamps are asserted rather than merely present. */
function clock(start = 1_000) {
  let value = start;
  return { now: () => value, advance(by: number) { value += by; return value; } };
}

test("a Stop reaches attention handlers for a lane attached after the channel connected", () => {
  let attached: BindingRecord | undefined;
  const hub = new ClaudeChannelHub((conversationId) => conversationId === "conv-1" ? attached : undefined);
  // The channel connects when the session starts, before any lane_attach_current call.
  hub.connect("conv-1", fakeSocket());
  const seen: string[] = [];
  hub.onAttentionOpportunity((value) => seen.push(value.id));

  attached = binding("conv-1");
  expect(hub.reportLifecycle("conv-1", "Stop")).toBe(true);

  expect(seen).toEqual(["binding-conv-1"]);
});

test("attention handlers see the current binding rather than one cached from an earlier generation", () => {
  let current = binding("conv-1");
  const hub = new ClaudeChannelHub((conversationId) => conversationId === "conv-1" ? current : undefined);
  hub.connect("conv-1", fakeSocket());
  const seen: number[] = [];
  hub.onAttentionOpportunity((value) => seen.push(value.generation));

  hub.reportLifecycle("conv-1", "Stop");
  current = { ...current, generation: 2 };
  hub.reportLifecycle("conv-1", "Stop");

  expect(seen).toEqual([1, 2]);
});

test("a conversation with no channel is reported as unreachable, not as busy or idle", () => {
  const hub = new ClaudeChannelHub();
  expect(hub.reach("absent")).toEqual({
    state: "no_channel", connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null,
  });
});

test("a freshly connected channel is unconfirmed until a lifecycle event arrives", () => {
  const time = clock();
  const hub = new ClaudeChannelHub(() => undefined, time.now);
  hub.connect("conv-1", fakeSocket());

  expect(hub.reach("conv-1")).toEqual({
    state: "unconfirmed", connectedAt: 1_000, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: false,
  });

  time.advance(500);
  hub.reportLifecycle("conv-1", "UserPromptSubmit");
  expect(hub.reach("conv-1")).toEqual({
    state: "live", connectedAt: 1_000, lastLifecycleAt: 1_500, lastNotifiedAt: null, believedBusy: true,
  });
});

// The fingerprint of a diverged session identity: notifications keep going out and the channel
// stays open, but no lifecycle event ever matches it, so the Router must not call it live.
test("a channel whose lifecycle events never match stays unconfirmed however often it is notified", async () => {
  const time = clock();
  const hub = new ClaudeChannelHub(() => undefined, time.now);
  hub.connect("conv-mcp", sendableSocket());

  time.advance(60_000);
  await expect(hub.notify(binding("conv-mcp"), notification)).resolves.toBe("sent");
  // The hook reports the session's own id, which is not the id the channel connected under.
  expect(hub.reportLifecycle("conv-hook", "Stop")).toBe(false);

  expect(hub.reach("conv-mcp")).toEqual({
    state: "unconfirmed", connectedAt: 1_000, lastLifecycleAt: null, lastNotifiedAt: 61_000, believedBusy: true,
  });
});

test("a notification that could not be written is reported apart from having no channel", async () => {
  const hub = new ClaudeChannelHub();
  const broken = {
    on: vi.fn(), close: vi.fn(), readyState: 1, OPEN: 1,
    send: vi.fn((_value: string, callback: (error?: Error) => void) => callback(new Error("socket is gone"))),
  } as unknown as WebSocket;
  hub.connect("conv-1", broken);

  await expect(hub.notify(binding("conv-1"), notification)).resolves.toBe("send_failed");
  await expect(hub.notify(binding("conv-2"), notification)).resolves.toBe("no_channel");
  // A failed write must not be recorded as a successful notification.
  expect(hub.reach("conv-1").lastNotifiedAt).toBeNull();
});

test("a closed socket stops being reachable even before the close event is processed", () => {
  const socket = sendableSocket();
  const hub = new ClaudeChannelHub();
  hub.connect("conv-1", socket);
  expect(hub.reach("conv-1").state).toBe("unconfirmed");
  socket.readyState = 3;
  expect(hub.reach("conv-1").state).toBe("no_channel");
});

// The defect this join exists for: the channel opens under the id of the process that made it,
// the hook reports the conversation's own id, and nothing connected the two. Every session
// restart then produced a binding nobody could reach, and no lifecycle event ever matched.
test("a lifecycle report adopts the channel that shares its join key", () => {
  const time = clock();
  const hub = new ClaudeChannelHub(() => undefined, time.now);
  hub.connect("mcp-server-id", sendableSocket(), "session-key");

  // Before the join the channel answers only to the process id that opened it.
  expect(hub.reach("mcp-server-id").state).toBe("unconfirmed");
  expect(hub.reach("conversation-id").state).toBe("no_channel");

  time.advance(100);
  expect(hub.reportLifecycle("conversation-id", "Stop", "session-key")).toBe(true);

  // Afterwards it answers to the conversation, which is what bindings are stored under.
  expect(hub.reach("conversation-id")).toMatchObject({ state: "live", lastLifecycleAt: 1_100 });
  expect(hub.reach("mcp-server-id").state).toBe("no_channel");
});

test("a report whose join key matches nothing is still refused", () => {
  const hub = new ClaudeChannelHub();
  hub.connect("mcp-server-id", sendableSocket(), "session-key");
  expect(hub.reportLifecycle("conversation-id", "Stop", "another-session-key")).toBe(false);
  expect(hub.reach("conversation-id").state).toBe("no_channel");
});

test("the identity a caller resolves to comes from the join, not from what it calls itself", () => {
  const hub = new ClaudeChannelHub();
  hub.connect("mcp-server-id", sendableSocket(), "session-key");

  expect(hub.resolveIdentity({ conversationId: "mcp-server-id", joinKey: "session-key" }))
    .toEqual({ value: "mcp-server-id", source: "caller" });

  hub.reportLifecycle("conversation-id", "UserPromptSubmit", "session-key");

  expect(hub.resolveIdentity({ conversationId: "mcp-server-id", joinKey: "session-key" }))
    .toEqual({ value: "conversation-id", source: "joined" });
  // A caller that offers no join key can only be taken at its word.
  expect(hub.resolveIdentity({ conversationId: "mcp-server-id" }))
    .toEqual({ value: "mcp-server-id", source: "caller" });
});

// This is the whole point: the process that opens the channel changes on every restart, the
// conversation does not, so the lane must still be reachable without being attached again — and
// the notification must go to the process that is actually running now.
test("a channel opened by a restarted process is recognised as the same conversation", async () => {
  const hub = new ClaudeChannelHub();
  const before = sendableSocket();
  hub.connect("mcp-server-before", before, "session-key-before");
  hub.reportLifecycle("conversation-id", "Stop", "session-key-before");
  expect(hub.reach("conversation-id").state).toBe("live");

  // The session restarts: new MCP server, new join key, same conversation. The predecessor's
  // socket may not have finished closing, so the join key has to decide which one is current.
  const after = sendableSocket();
  hub.connect("mcp-server-after", after, "session-key-after");
  hub.reportLifecycle("conversation-id", "UserPromptSubmit", "session-key-after");

  expect(hub.reach("conversation-id").state).toBe("live");
  await expect(hub.notify(binding("conversation-id"), notification)).resolves.toBe("sent");
  expect(after.send).toHaveBeenCalledOnce();
  expect(before.send).not.toHaveBeenCalled();
  // The superseded channel is closed rather than left open with nothing routed to it.
  expect(before.close).toHaveBeenCalledWith(1000, "replaced");
  expect(hub.resolveIdentity({ conversationId: "mcp-server-after", joinKey: "session-key-after" }))
    .toEqual({ value: "conversation-id", source: "joined" });
});

test("a reconnecting channel does not inherit an identity until its own hook reports again", () => {
  const hub = new ClaudeChannelHub();
  const first = sendableSocket();
  hub.connect("mcp-server-id", first, "session-key");
  hub.reportLifecycle("conversation-id", "Stop", "session-key");
  expect(hub.reach("conversation-id").state).toBe("live");

  // A pid is only unique among live processes. A channel must therefore never be handed an
  // identity on the strength of a remembered key alone, or a session that reused the number
  // would start receiving another conversation's notifications.
  hub.connect("mcp-server-id", sendableSocket(), "session-key");
  expect(hub.reach("mcp-server-id").state).toBe("unconfirmed");
  hub.reportLifecycle("conversation-id", "UserPromptSubmit", "session-key");
  expect(hub.reach("conversation-id").state).toBe("live");
});

test("a join key stops meaning anything once its channel is gone", () => {
  const hub = new ClaudeChannelHub();
  const socket = sendableSocket();
  let onClose = () => undefined as void;
  (socket.on as unknown as { mock: { calls: Array<[string, () => void]> } });
  hub.connect("mcp-server-id", socket, "session-key");
  for (const [event, handler] of (socket.on as unknown as { mock: { calls: Array<[string, () => void]> } }).mock.calls) {
    if (event === "close") onClose = handler;
  }
  hub.reportLifecycle("conversation-id", "Stop", "session-key");
  expect(hub.resolveIdentity({ conversationId: "mcp-server-id", joinKey: "session-key" }))
    .toEqual({ value: "conversation-id", source: "joined" });

  onClose();

  expect(hub.resolveIdentity({ conversationId: "someone-else", joinKey: "session-key" }))
    .toEqual({ value: "someone-else", source: "caller" });
});
