import type { WebSocket } from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ClaudeChannelHub, type RenotifyEvent } from "../../src/process/local-server.js";
import type { Notification } from "../../src/router/backend.js";
import type { BindingRecord } from "../../src/router/types.js";

// Spec 2026-10-20-wake-renotify.md: a frame that starts no turn is offered again on a bounded
// back-off. The clock is vitest's, so the hub's own Date.now and setTimeout are the ones driven.
beforeEach(() => { vi.useFakeTimers({ now: 0 }); });
afterEach(() => { vi.useRealTimers(); });

const lane: BindingRecord = {
  id: "binding-conv-1", laneAddress: "alpha/worker", backend: "claude", conversationId: "conv-1",
  generation: 1, startup: {}, activeAt: 1, inactiveAt: null,
};

/** A far end that records every frame and when it left, and can hang up. */
function farEnd() {
  const handlers = new Map<string, () => void>();
  const frames: { at: number; messageIds: readonly string[] }[] = [];
  const socket = {
    readyState: 1, OPEN: 1,
    on: vi.fn((event: string, handler: () => void) => { handlers.set(event, handler); }),
    close: vi.fn(),
    send: vi.fn((raw: string, callback: (error?: Error) => void) => {
      frames.push({ at: Date.now(), messageIds: (JSON.parse(raw) as { notification: Notification }).notification.messageIds });
      callback();
    }),
  };
  return { socket: socket as unknown as WebSocket, frames, hangUp() { socket.readyState = 3; handlers.get("close")?.(); } };
}

function frame(messageIds: readonly string[], kind: Notification["kind"] = "normal"): Notification {
  return { laneAddress: lane.laneAddress, pendingPath: "C:/mailbox/pending", kind, messageIds: [...messageIds], messages: messageIds.map((id) => ({ id, sender: "alpha/hub", summary: "" })) };
}

/** The pump's part: every opportunity notifies the lane of exactly what is pending at that moment. */
function router(pending: string[]) {
  const logged: RenotifyEvent[] = [];
  const hub = new ClaudeChannelHub((id) => id === lane.conversationId ? lane : undefined, undefined, undefined, (event) => { logged.push(event); });
  hub.onAttentionOpportunity((binding) => { if (pending.length > 0) void hub.notify(binding, frame(pending)); });
  return { hub, logged };
}

async function connected(pending: string[]) {
  const x = router(pending);
  const far = farEnd();
  x.hub.connect(lane.conversationId, far.socket);
  await vi.advanceTimersByTimeAsync(0);
  return { ...x, far };
}

test("acceptance 1: a frame that starts no turn goes again after 15, 60, 180 and 600 seconds, then no more", async () => {
  const { far, logged } = await connected(["m1"]);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(far.frames.map((frame) => frame.at)).toEqual([0, 15_000, 75_000, 255_000, 855_000]);
  expect(logged).toEqual([1, 2, 3, 4].map((attempt, index) => ({
    event: "channel.renotify", laneAddress: "alpha/worker", conversationId: "conv-1", attempt,
    sinceFirstMs: [15_000, 75_000, 255_000, 855_000][index], at: [15_000, 75_000, 255_000, 855_000][index],
  })));
});

test("acceptance 2: a lifecycle after the frame means it was taken, so nothing is sent again", async () => {
  const { hub, far, logged } = await connected(["m1"]);
  await vi.advanceTimersByTimeAsync(10_000);
  hub.reportLifecycle(lane.conversationId, "UserPromptSubmit");
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(far.frames.map((frame) => frame.at)).toEqual([0]);
  expect(logged).toEqual([]);
});

test("acceptance 3: once nothing is pending there is nothing to offer again", async () => {
  const pending = ["m1"];
  const { far, logged } = await connected(pending);
  pending.length = 0;
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(far.frames.map((frame) => frame.at)).toEqual([0]);
  expect(logged).toEqual([]);
});

test("acceptance 4: a hang-up cancels the rest, and the channel that reconnects starts its own cycle", async () => {
  const { hub, far, logged } = await connected(["m1"]);
  await vi.advanceTimersByTimeAsync(5_000);
  far.hangUp();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(far.frames.map((frame) => frame.at)).toEqual([0]);
  const again = farEnd();
  hub.connect(lane.conversationId, again.socket);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(again.frames.map((frame) => frame.at)).toEqual([105_000, 120_000]);
  expect(logged.map((event) => [event.attempt, event.sinceFirstMs])).toEqual([[1, 15_000]]);
});

test("acceptance 5: what is sent again is what is pending then, not the first frame over again", async () => {
  const pending = ["m1"];
  const { far } = await connected(pending);
  pending.push("m2");
  await vi.advanceTimersByTimeAsync(15_000);
  expect(far.frames.map((frame) => frame.messageIds)).toEqual([["m1"], ["m1", "m2"]]);
});

test("a message that arrives mid-cycle is news: its frame starts the back-off over", async () => {
  const pending = ["m1"];
  const { hub, far, logged } = await connected(pending);
  await vi.advanceTimersByTimeAsync(30_000);
  pending.push("m2");
  void hub.notify(lane, frame(pending));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(far.frames.map((frame) => frame.at)).toEqual([0, 15_000, 30_000, 45_000]);
  expect(logged.map((event) => [event.attempt, event.sinceFirstMs])).toEqual([[1, 15_000], [1, 15_000]]);
});

test("one renotify that the pump sends as several frames counts once", async () => {
  const pending = ["m1"];
  const { hub, far, logged } = await connected(pending);
  // A correction travels in a frame of its own, after the normal one, as notifyLane sends them.
  hub.onAttentionOpportunity((binding) => { void Promise.resolve().then(() => hub.notify(binding, frame(["m1"], "correction"))); });
  await vi.advanceTimersByTimeAsync(75_000);
  expect(far.frames.filter((frame) => frame.at === 15_000)).toHaveLength(2);
  expect(far.frames.filter((frame) => frame.at === 75_000)).toHaveLength(2);
  expect(logged.map((event) => event.attempt)).toEqual([1, 2]);
});

test("acceptance 6: a frame that reaches a turn in progress waits for that turn's Stop, and the Stop's frame starts the cycle", async () => {
  const pending: string[] = [];
  const { hub, far, logged } = await connected(pending);
  hub.reportLifecycle(lane.conversationId, "UserPromptSubmit");
  await vi.advanceTimersByTimeAsync(5_000);
  // Claude Code queues a frame that arrives mid-turn and hands it over when the turn ends.
  pending.push("m1");
  void hub.notify(lane, frame(pending));
  await vi.advanceTimersByTimeAsync(55_000);
  expect(far.frames.map((sent) => sent.at)).toEqual([5_000]);
  hub.reportLifecycle(lane.conversationId, "Stop");
  await vi.advanceTimersByTimeAsync(15_000);
  expect(far.frames.map((sent) => sent.at)).toEqual([5_000, 60_000, 75_000]);
  expect(logged.map((event) => [event.attempt, event.sinceFirstMs])).toEqual([[1, 15_000]]);
});

test("a re-offer does not let anyone waiting to take the lane over through: only a Stop does", async () => {
  const { hub } = await connected(["m1"]);
  let released = false;
  void hub.waitUntilReplaceable(lane).then(() => { released = true; });
  await vi.advanceTimersByTimeAsync(80_000);
  expect(released).toBe(false);
  hub.reportLifecycle(lane.conversationId, "Stop");
  await vi.advanceTimersByTimeAsync(0);
  expect(released).toBe(true);
});

test("closing the hub leaves no timer behind", async () => {
  const { hub } = await connected(["m1"]);
  hub.close();
  expect(vi.getTimerCount()).toBe(0);
});
