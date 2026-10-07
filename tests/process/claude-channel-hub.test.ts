import type { WebSocket } from "ws";
import { expect, test, vi } from "vitest";

import { ClaudeBackend } from "../../src/backends/claude-backend.js";
import { ClaudeChannelHub, type JoinEvent } from "../../src/process/local-server.js";
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
  messages: [{ id: "message-1", sender: "alpha/hub", summary: "本轮 lane 重构的顺序" }],
};

/** A clock the test drives, so timestamps are asserted rather than merely present. */
function clock(start = 1_000) {
  let value = start;
  return { now: () => value, advance(by: number) { value += by; return value; } };
}

/** Stands in for the stderr line the Router itself would write, so a pairing is asserted by sequence. */
function joinRecorder(): { events: JoinEvent[]; sink: (event: JoinEvent) => void } {
  const events: JoinEvent[] = [];
  return { events, sink: (event) => { events.push(event); } };
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

// A preloaded first prompt (rotation, `lane-router-lane new`) fires the UserPromptSubmit hook while
// the MCP server is still opening its channel. The report lands on nothing; the channel that
// follows has no lifecycle; and nothing re-joins them until the next human prompt — which an
// unattended lane never gets. Measured on another lane: attach refused three times in the first
// turn, accepted once on the next.
test("a report that beat its own channel is applied when that channel connects soon after", () => {
  const time = clock();
  const hub = new ClaudeChannelHub(() => undefined, time.now);

  // Honest about what happened at the time: nothing carried it, so it was not accepted.
  expect(hub.reportLifecycle("conversation-id", "UserPromptSubmit", "session-key")).toBe(false);
  expect(hub.reach("conversation-id").state).toBe("no_channel");

  time.advance(3_000);
  hub.connect("mcp-server-id", sendableSocket(), "session-key");

  // Everything validateAttach asks of a caller in that first turn, on the real objects.
  expect(hub.reach("conversation-id")).toMatchObject({ state: "live", believedBusy: true, lastLifecycleAt: 1_000 });
  expect(hub.reach("mcp-server-id").state).toBe("no_channel");
  expect(hub.resolveIdentity({ conversationId: "mcp-server-id", joinKey: "session-key" }))
    .toEqual({ value: "conversation-id", source: "joined" });
  expect(new ClaudeBackend(hub).validateAttach({ backend: "claude", conversationId: "mcp-server-id", joinKey: "session-key", requestKey: "r" }))
    .toBeUndefined();
});

test("a report that beat its channel by more than the window is not applied to it", () => {
  const time = clock();
  const hub = new ClaudeChannelHub(() => undefined, time.now);
  hub.reportLifecycle("conversation-id", "UserPromptSubmit", "session-key");

  // Long enough that the process which opened this channel cannot be the one the hook spoke for:
  // a pid reused after a session died must not be handed that session's report.
  time.advance(31_000);
  hub.connect("mcp-server-id", sendableSocket(), "session-key");

  expect(hub.reach("conversation-id").state).toBe("no_channel");
  expect(hub.reach("mcp-server-id")).toMatchObject({ state: "unconfirmed", lastLifecycleAt: null });
  // And a second connect does not get to spend the same stale report either.
  hub.connect("mcp-server-id-2", sendableSocket(), "session-key");
  expect(hub.reach("conversation-id").state).toBe("no_channel");
});

test("an early Stop is applied as idle, and releases anyone waiting on that conversation", async () => {
  const time = clock();
  const hub = new ClaudeChannelHub(() => undefined, time.now);
  hub.reportLifecycle("conversation-id", "Stop", "session-key");
  time.advance(2_000);
  hub.connect("mcp-server-id", sendableSocket(), "session-key");

  expect(hub.reach("conversation-id")).toMatchObject({ state: "live", believedBusy: false });
  // Not busy, so a takeover of this conversation's lane does not wait at all.
  await expect(hub.waitUntilReplaceable(binding("conversation-id"))).resolves.toBeUndefined();
});

// The wait used to be unbounded on this side while the caller's transport gave up at two minutes.
// The caller saw `fetch failed`, and the waiter left behind could still release later and let a
// takeover complete that had already been reported as failed.
test("a caller that gives up takes its waiter with it", async () => {
  const hub = new ClaudeChannelHub();
  hub.connect("busy-conv", sendableSocket());
  hub.reportLifecycle("busy-conv", "UserPromptSubmit");
  expect(hub.reach("busy-conv").believedBusy).toBe(true);

  const abandoned = new AbortController();
  const waiting = hub.waitUntilReplaceable(binding("busy-conv"), abandoned.signal);
  const reason = new Error("the caller disconnected");
  abandoned.abort(reason);
  await expect(waiting).rejects.toBe(reason);

  // The predecessor finishing its turn afterwards must not resurrect the abandoned takeover.
  let resurrected = false;
  const second = hub.waitUntilReplaceable(binding("busy-conv")).then(() => { resurrected = true; });
  hub.reportLifecycle("busy-conv", "Stop");
  await second;
  expect(resurrected).toBe(true);
});

test("an already-abandoned caller never joins the queue at all", async () => {
  const hub = new ClaudeChannelHub();
  hub.connect("busy-conv", sendableSocket());
  hub.reportLifecycle("busy-conv", "UserPromptSubmit");
  await expect(hub.waitUntilReplaceable(binding("busy-conv"), AbortSignal.abort(new Error("gone"))))
    .rejects.toThrow(/gone/u);
});

// The join record is what turns "first turn attach failed, next turn worked" from an anecdote
// into a timeline: each test below asserts the exact sequence a post-mortem would read back.
test("a held report paired with a later channel is recorded from both sides", () => {
  const time = clock();
  const { events, sink } = joinRecorder();
  const hub = new ClaudeChannelHub(() => undefined, time.now, sink);

  expect(hub.reportLifecycle("conversation-id", "UserPromptSubmit", "session-key")).toBe(false);
  time.advance(3_000);
  hub.connect("mcp-server-id", sendableSocket(), "session-key");

  // reportAt and at are the two halves; deltaMs is their gap, already computed.
  expect(events).toEqual([
    { event: "join.lifecycle_received", joinKey: "session-key", conversationId: "conversation-id", lifecycle: "UserPromptSubmit", at: 1_000, outcome: "held" },
    { event: "join.channel_connected", joinKey: "session-key", conversationId: "mcp-server-id", at: 4_000, outcome: "placed", reportConversationId: "conversation-id", reportAt: 1_000, deltaMs: 3_000 },
  ]);
});

test("a held report dropped at the window is recorded as expired", () => {
  const time = clock();
  const { events, sink } = joinRecorder();
  const hub = new ClaudeChannelHub(() => undefined, time.now, sink);

  hub.reportLifecycle("conversation-id", "UserPromptSubmit", "session-key");
  time.advance(31_000);
  hub.connect("mcp-server-id", sendableSocket(), "session-key");

  expect(events).toEqual([
    { event: "join.lifecycle_received", joinKey: "session-key", conversationId: "conversation-id", lifecycle: "UserPromptSubmit", at: 1_000, outcome: "held" },
    { event: "join.channel_connected", joinKey: "session-key", conversationId: "mcp-server-id", at: 32_000, outcome: "expired", reportConversationId: "conversation-id", reportAt: 1_000, deltaMs: 31_000 },
    { event: "join.unplaced_expired", joinKey: "session-key", conversationId: "conversation-id", at: 32_000, reportAt: 1_000, deltaMs: 31_000 },
  ]);
});

test("a report that adopts a connected channel is recorded with the gap since connect", () => {
  const time = clock();
  const { events, sink } = joinRecorder();
  const hub = new ClaudeChannelHub(() => undefined, time.now, sink);

  hub.connect("mcp-server-id", sendableSocket(), "session-key");
  time.advance(100);
  expect(hub.reportLifecycle("conversation-id", "Stop", "session-key")).toBe(true);

  expect(events).toEqual([
    { event: "join.channel_connected", joinKey: "session-key", conversationId: "mcp-server-id", at: 1_000, outcome: "awaiting_report" },
    { event: "join.lifecycle_received", joinKey: "session-key", conversationId: "conversation-id", lifecycle: "Stop", at: 1_100, outcome: "adopted", deltaMs: 100 },
  ]);
});

test("traffic that carries no join key is not a join and is not recorded", () => {
  const time = clock();
  const { events, sink } = joinRecorder();
  const hub = new ClaudeChannelHub(() => undefined, time.now, sink);

  hub.connect("conv-1", sendableSocket());
  hub.reportLifecycle("conv-1", "Stop");

  expect(events).toEqual([]);
});

// The residual the window exists for: the session that claimed an identity died without a channel
// close ever naming its key (the channel never came, or died before the report did). Nothing but
// the window can retire that claim, and afterwards a caller presenting the key is taken at its
// own word again instead of being filed under a dead conversation.
test("an identity whose channel never came expires with the unplaced-report window", () => {
  const time = clock();
  const hub = new ClaudeChannelHub(() => undefined, time.now);
  hub.reportLifecycle("conversation-id", "UserPromptSubmit", "session-key");

  expect(hub.resolveIdentity({ conversationId: "mcp-server-id", joinKey: "session-key" }))
    .toEqual({ value: "conversation-id", source: "joined" });
  // The boundary is the same inclusive one the unplaced report itself lives by: alive at exactly
  // the window, dead one tick past it.
  time.advance(30_000);
  expect(hub.resolveIdentity({ conversationId: "mcp-server-id", joinKey: "session-key" }))
    .toEqual({ value: "conversation-id", source: "joined" });

  time.advance(1);
  expect(hub.resolveIdentity({ conversationId: "mcp-server-id", joinKey: "session-key" }))
    .toEqual({ value: "mcp-server-id", source: "caller" });
});

// A session mid-turn reports nothing for far longer than the window; its identity is as alive as
// its conversation's channel, so the backstop must not retire it underneath a live session.
test("an identity does not expire while its conversation's channel is open", () => {
  const time = clock();
  const hub = new ClaudeChannelHub(() => undefined, time.now);
  hub.connect("mcp-server-id", sendableSocket(), "session-key");
  hub.reportLifecycle("conversation-id", "Stop", "session-key");

  time.advance(3_600_000);
  expect(hub.resolveIdentity({ conversationId: "mcp-server-id", joinKey: "session-key" }))
    .toEqual({ value: "conversation-id", source: "joined" });
});

// The pid-reuse shape: the key was claimed by a session that died, and a new session's channel
// now carries the same key. Liveness is anchored to the mapped conversation, not to the key, so
// the new channel cannot keep the dead identity alive — the new session's first caller resolves
// to itself rather than inheriting the stranger's conversation.
test("a reused join key does not inherit the dead session's identity", () => {
  const time = clock();
  const hub = new ClaudeChannelHub(() => undefined, time.now);
  hub.reportLifecycle("old-conversation", "UserPromptSubmit", "session-key");

  time.advance(31_000);
  hub.connect("new-mcp-server-id", sendableSocket(), "session-key");

  expect(hub.resolveIdentity({ conversationId: "new-mcp-server-id", joinKey: "session-key" }))
    .toEqual({ value: "new-mcp-server-id", source: "caller" });
});
