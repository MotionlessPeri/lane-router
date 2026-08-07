import { expect, test, vi } from "vitest";
import { CodexAdapter } from "../../../src/adapters/codex/codex-adapter.js";

const delivery = { deliveryId: "d", messageId: "m", targetLaneId: "p/b", sequence: 1, kind: "normal", bindingGeneration: 2 } as const;

function setup(status: "idle" | "busy" = "idle") {
  const request = vi.fn(async (method: string) => method === "thread/read"
    ? { thread: { id: "th", status: { type: status }, turns: status === "busy" ? [{ id: "turn", status: "inProgress" }] : [] } }
    : method === "thread/start" ? { thread: { id: "th" } }
    : method === "turn/start" ? { turn: { id: "turn", status: "inProgress", items: [] } }
    : method === "turn/steer" ? { turnId: "turn" } : {});
  const connected = vi.fn(() => true);
  const beforeClaim = vi.fn();
  const adapter = new CodexAdapter({ client: { request, isConnected: connected }, resolveBinding: () => ({ threadId: "th" }), loadMessage: () => "hello", beforeClaim });
  return { adapter, request, connected, beforeClaim };
}

test("runtime state probes App Server and never reports idle while disconnected", async () => {
  const x = setup("idle");
  expect(await x.adapter.getRuntimeState(delivery)).toEqual({ availability: "online", turn: "idle" });
  x.connected.mockReturnValue(false);
  expect(await x.adapter.getRuntimeState(delivery)).toEqual({ availability: "offline", turn: "unknown" });
});

test("runtime state never reports idle for an unknown App Server status", async () => {
  const adapter = new CodexAdapter({ client: { isConnected: () => true, request: vi.fn(async () => ({ thread: { id: "th", status: { type: "notLoaded" } } })) }, resolveBinding: () => ({ threadId: "th" }), loadMessage: () => "x" });
  expect(await adapter.getRuntimeState(delivery)).toEqual({ availability: "degraded", turn: "unknown" });
});

test("idle delivery starts a turn and signals before claim", async () => {
  const x = setup("idle");
  expect(await x.adapter.deliver(delivery)).toBe("started_new_turn");
  expect(x.beforeClaim).toHaveBeenCalledWith(delivery, "turn");
  expect(x.request.mock.calls.map(([method]) => method)).toEqual(["thread/read", "turn/start"]);
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
  x.request.mockResolvedValue({ thread: { id: "th", status: { type: "busy" }, turns: [] } });
  expect(await x.adapter.deliver({ ...delivery, kind: "correction" })).toBe("adapter_failed");
  expect(x.request).not.toHaveBeenCalledWith("turn/steer", expect.anything());
});

test("missing binding and offline transport map exactly", async () => {
  const missing = new CodexAdapter({ client: { request: vi.fn(), isConnected: () => true }, resolveBinding: () => undefined, loadMessage: () => "x" });
  expect(await missing.deliver(delivery)).toBe("binding_not_found");
  const offline = setup();
  offline.connected.mockReturnValue(false);
  expect(await offline.adapter.deliver(delivery)).toBe("stored_pending");
});

test("missing persisted App Server thread maps to binding_not_found", async () => {
  const adapter = new CodexAdapter({ client: { isConnected: () => true, request: vi.fn(async () => { throw new Error("thread not found"); }) }, resolveBinding: () => ({ threadId: "deleted" }), loadMessage: () => "x" });
  expect(await adapter.deliver(delivery)).toBe("binding_not_found");
});

test("starts new and resumes persisted threads", async () => {
  const x = setup();
  expect(await x.adapter.startThread({ cwd: "C:/tmp" })).toBe("th");
  x.request.mockResolvedValueOnce({ thread: { id: "persisted" } });
  expect(await x.adapter.resumeThread("persisted")).toBe("persisted");
});
