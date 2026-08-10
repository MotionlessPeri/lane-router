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
