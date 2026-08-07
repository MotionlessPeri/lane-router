import { expect, test, vi } from "vitest";
import { ChannelBridge, type ClaudeChannelNotification } from "../../../src/adapters/claude/channel-bridge.js";
import type { AdapterDeliveryRequest } from "../../../src/core/adapter-contract.js";

function delivery(messageId = "message-1", deliveryId = "delivery-1"): AdapterDeliveryRequest {
  return { deliveryId, deliveryIds: [deliveryId], messageId, messageIds: [messageId], targetLaneId: "project/lane", sequence: 7, kind: "normal", bindingGeneration: 3 };
}

function sink(send = vi.fn(async (_notification: ClaudeChannelNotification) => undefined)) { return { notification: send }; }

test("idle Channel wake emits only a minimal ID envelope and deduplicates replay", async () => {
  const send = vi.fn(async (_notification: ClaudeChannelNotification) => undefined);
  const bridge = new ChannelBridge();
  bridge.attach(sink(send));
  expect(await bridge.wake(delivery())).toBe("started_new_turn");
  expect(await bridge.wake(delivery())).toBe("started_new_turn");
  expect(send).toHaveBeenCalledOnce();
  const notification = send.mock.calls[0]![0];
  expect(notification.method).toBe("notifications/claude/channel");
  expect(JSON.parse(notification.params.content)).toEqual({ deliveryIds: ["delivery-1"], messageIds: ["message-1"], targetLaneId: "project/lane", sequence: 7, kind: "normal" });
  expect(notification.params.meta).toEqual({ message_id: "message-1" });
  expect(JSON.stringify(notification)).not.toContain("body");
});

test("a partially replayed batch notifies only unseen message IDs", async () => {
  const send = vi.fn(async (_notification: ClaudeChannelNotification) => undefined);
  const bridge = new ChannelBridge();
  bridge.attach(sink(send));
  await bridge.wake(delivery("message-1", "delivery-1"));
  const overlapping = { ...delivery("message-1", "delivery-1"), deliveryIds: ["delivery-1", "delivery-2"], messageIds: ["message-1", "message-2"] };
  await expect(bridge.wake(overlapping)).resolves.toBe("queued_next_turn");
  expect(JSON.parse(send.mock.calls[1]![0].params.content)).toMatchObject({ deliveryIds: ["delivery-2"], messageIds: ["message-2"] });
});

test("busy Channel delivery is sent for the next turn and disconnected delivery stays pending", async () => {
  const send = vi.fn(async (_notification: ClaudeChannelNotification) => undefined);
  const bridge = new ChannelBridge();
  expect(await bridge.wake(delivery())).toBe("stored_pending");
  bridge.attach(sink(send));
  bridge.setBusy(true);
  expect(await bridge.wake(delivery("message-busy", "delivery-busy"))).toBe("queued_next_turn");
  bridge.detach();
  expect(await bridge.wake(delivery("message-offline", "delivery-offline"))).toBe("stored_pending");
  expect(send).toHaveBeenCalledOnce();
});

test("Channel wake coalesces concurrency and retries with injected bounded jitter", async () => {
  const delays: number[] = [];
  let attempts = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const send = vi.fn(async () => { attempts += 1; if (attempts < 3) throw new Error("temporary write failure"); await blocked; });
  const bridge = new ChannelBridge({ maxNotifyAttempts: 3, retryBaseMs: 100, retryCapMs: 150, random: () => 0.5, sleep: async (ms) => { delays.push(ms); } });
  bridge.attach(sink(send));
  const first = bridge.wake(delivery());
  const second = bridge.wake(delivery());
  await vi.waitFor(() => expect(attempts).toBe(3));
  release?.();
  expect(await Promise.all([first, second])).toEqual(["started_new_turn", "started_new_turn"]);
  expect(send).toHaveBeenCalledTimes(3);
  expect(delays).toEqual([50, 75]);
});

test("Channel reconnect callback restores availability and seen-ID cache stays bounded", async () => {
  let now = 0;
  const reconnected = vi.fn(async () => undefined);
  const send = vi.fn(async (_notification: ClaudeChannelNotification) => undefined);
  const bridge = new ChannelBridge({ onReconnect: reconnected, now: () => now, completedTtlMs: 10, maxSeenMessageIds: 2 });
  bridge.attach(sink(send));
  await bridge.wake(delivery("m1", "d1"));
  bridge.setBusy(false); await bridge.wake(delivery("m2", "d2"));
  bridge.detach();
  expect(bridge.getRuntimeState()).toEqual({ availability: "offline", turn: "unknown" });
  bridge.attach(sink(send));
  await vi.waitFor(() => expect(reconnected).toHaveBeenCalledOnce());
  bridge.setBusy(false); await bridge.wake(delivery("m3", "d3"));
  bridge.setBusy(false); await bridge.wake(delivery("m1", "d1"));
  expect(send).toHaveBeenCalledTimes(4);
  now = 20;
  bridge.setBusy(false); await bridge.wake(delivery("m3", "d3"));
  expect(send).toHaveBeenCalledTimes(5);
});
