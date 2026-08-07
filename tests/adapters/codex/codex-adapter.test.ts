import { expect, test, vi } from "vitest";
import { CodexAdapter } from "../../../src/adapters/codex/codex-adapter.js";

const delivery = { deliveryId: "d", messageId: "m", targetLaneId: "p/b", sequence: 1, kind: "normal", bindingGeneration: 2 } as const;

function setup(state: "idle" | "busy" = "idle") {
  const status = state === "busy" ? "active" : "idle";
  const request = vi.fn(async (method: string) => method === "thread/read"
    ? { thread: { id: "th", status: { type: status }, turns: state === "busy" ? [{ id: "turn", status: "inProgress", items: [] }] : [] } }
    : method === "thread/start" ? { thread: { id: "th", status: { type: "idle" }, turns: [] } }
    : method === "thread/resume" ? { thread: { id: "th", status: { type: "idle" }, turns: [] } }
    : method === "turn/start" ? { turn: { id: "turn", status: "inProgress", items: [] } }
    : method === "turn/steer" ? { turnId: "turn" } : {});
  const connected = vi.fn(() => true);
  const beforeClaim = vi.fn();
  const adapter = new CodexAdapter({ client: { request, isConnected: connected }, resolveBinding: () => ({ threadId: "th" }), beforeClaim });
  return { adapter, request, connected, beforeClaim };
}

test("runtime state probes App Server and never reports idle while disconnected", async () => {
  const x = setup("idle");
  expect(await x.adapter.getRuntimeState(delivery)).toEqual({ availability: "online", turn: "idle" });
  x.connected.mockReturnValue(false);
  expect(await x.adapter.getRuntimeState(delivery)).toEqual({ availability: "offline", turn: "unknown" });
});

test("runtime state never reports idle for an unknown App Server status", async () => {
  const adapter = new CodexAdapter({ client: { isConnected: () => true, request: vi.fn(async () => ({ thread: { id: "th", status: { type: "notLoaded" }, turns: [] } })) }, resolveBinding: () => ({ threadId: "th" }) });
  expect(await adapter.getRuntimeState(delivery)).toEqual({ availability: "degraded", turn: "unknown" });
});

test("idle delivery starts a turn and signals before claim", async () => {
  const x = setup("idle");
  expect(await x.adapter.deliver(delivery)).toBe("started_new_turn");
  expect(x.beforeClaim).toHaveBeenCalledWith(delivery, "turn");
  expect(x.request.mock.calls.map(([method]) => method)).toEqual(["thread/read", "turn/start"]);
});

test("batch wake includes every ordered ID and no message body", async () => {
  const x = setup("idle");
  const batch = { ...delivery, deliveryId: "d1", messageId: "m1", deliveryIds: ["d1", "d2", "d3"], messageIds: ["m1", "m2", "m3"] };
  expect(await x.adapter.deliver(batch)).toBe("started_new_turn");
  const turnStart = x.request.mock.calls.find(([method]) => method === "turn/start");
  expect(turnStart).toBeDefined();
  const input = (turnStart?.[1] as { input: Array<{ text: string }> }).input[0]!.text;
  expect(JSON.parse(input)).toEqual({ deliveryIds: ["d1", "d2", "d3"], messageIds: ["m1", "m2", "m3"] });
  expect(input).not.toContain("hello");
});

test("correction steer carries the complete body-free batch wake", async () => {
  const x = setup("busy");
  const batch = { ...delivery, deliveryId: "d1", messageId: "m1", kind: "correction" as const, deliveryIds: ["d1", "d2", "d3"], messageIds: ["m1", "m2", "m3"] };
  expect(await x.adapter.deliver(batch)).toBe("applied_current_turn");
  const steer = x.request.mock.calls.find(([method]) => method === "turn/steer");
  const input = (steer?.[1] as { input: Array<{ text: string }> }).input[0]!.text;
  expect(JSON.parse(input)).toEqual({ deliveryIds: ["d1", "d2", "d3"], messageIds: ["m1", "m2", "m3"] });
  expect(input).not.toContain("hello");
});

test("busy normal queues without steering, while correction steers", async () => {
  const normal = setup("busy");
  expect(await normal.adapter.deliver(delivery)).toBe("queued_next_turn");
  expect(normal.request).toHaveBeenCalledTimes(1);
  const correction = setup("busy");
  expect(await correction.adapter.deliver({ ...delivery, kind: "correction" })).toBe("applied_current_turn");
  expect(correction.request).toHaveBeenLastCalledWith("turn/steer", expect.objectContaining({ threadId: "th", expectedTurnId: "turn" }));
});

test("correction fails safely when busy state has no authoritative active turn", async () => {
  const x = setup("busy");
  x.request.mockResolvedValue({ thread: { id: "th", status: { type: "active" }, turns: [] } });
  expect(await x.adapter.deliver({ ...delivery, kind: "correction" })).toBe("adapter_failed");
  expect(x.request).not.toHaveBeenCalledWith("turn/steer", expect.anything());
});

test("missing binding and offline transport map exactly", async () => {
  const missing = new CodexAdapter({ client: { request: vi.fn(), isConnected: () => true }, resolveBinding: () => undefined });
  expect(await missing.deliver(delivery)).toBe("binding_not_found");
  const offline = setup();
  offline.connected.mockReturnValue(false);
  expect(await offline.adapter.deliver(delivery)).toBe("stored_pending");
});

test("missing persisted App Server thread maps to binding_not_found", async () => {
  const adapter = new CodexAdapter({ client: { isConnected: () => true, request: vi.fn(async () => { throw new Error("thread not found"); }) }, resolveBinding: () => ({ threadId: "deleted" }) });
  expect(await adapter.deliver(delivery)).toBe("binding_not_found");
});

test("starts new and resumes persisted threads", async () => {
  const x = setup();
  expect(await x.adapter.startThread({ cwd: "C:/tmp", developerInstructions: "Fetch every wake message through lane_message_get." })).toBe("th");
  expect(x.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ cwd: "C:/tmp", developerInstructions: "Fetch every wake message through lane_message_get.", dynamicTools: expect.arrayContaining([expect.objectContaining({ name: "lane_message_get" })]) }));
  x.request.mockResolvedValueOnce({ thread: { id: "persisted", status: { type: "idle" }, turns: [] } });
  expect(await x.adapter.resumeThread("persisted")).toBe("persisted");
});

test("binding rotation during a delayed probe never starts the stale thread", async () => {
  let releaseProbe: ((value: unknown) => void) | undefined;
  const probe = new Promise((resolve) => { releaseProbe = resolve; });
  let binding: { threadId: string } | undefined = { threadId: "old-thread" };
  const request = vi.fn(async (method: string) => method === "thread/read" ? probe : { turn: { id: "turn", status: "inProgress", items: [] } });
  const adapter = new CodexAdapter({ client: { request, isConnected: () => true }, resolveBinding: () => binding });
  const deliveryTask = adapter.deliver(delivery);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("thread/read", expect.objectContaining({ threadId: "old-thread" })));
  binding = { threadId: "new-thread" };
  releaseProbe?.({ thread: { id: "old-thread", status: { type: "idle" }, turns: [] } });
  await expect(deliveryTask).resolves.toBe("binding_changed_retry");
  expect(request).not.toHaveBeenCalledWith("turn/start", expect.anything());
  expect(request).not.toHaveBeenCalledWith("turn/steer", expect.anything());
});

test("adapter rejects a wake envelope beyond its defensive count bound", async () => {
  const x = setup("idle");
  const ids = Array.from({ length: 65 }, (_, index) => `d-${index}`);
  const messages = Array.from({ length: 65 }, (_, index) => `m-${index}`);
  await expect(x.adapter.deliver({ ...delivery, deliveryId: ids[0]!, messageId: messages[0]!, deliveryIds: ids, messageIds: messages })).rejects.toThrow(/maximum count/i);
  expect(x.request).toHaveBeenCalledTimes(1);
});
