import { describe, expect, it, vi } from "vitest";

import { CodexBackend } from "../../src/backends/codex-backend.js";
import type { BindingRecord } from "../../src/router/types.js";

const binding: BindingRecord = {
  id: "binding-1", laneAddress: "alpha/design", backend: "codex", conversationId: "thread-1",
  generation: 1, startup: {}, activeAt: 1, inactiveAt: null, cwd: null,
};
const notification = {
  laneAddress: "alpha/design", pendingPath: "C:/mailboxes/alpha/design/pending",
  kind: "normal" as const, messageIds: ["message-1", "message-2"],
};

function setup(status: "idle" | "active" | "notLoaded" = "idle") {
  let current = status;
  let connected = true;
  let visibleClient = false;
  let notificationHandler: ((message: { method: string; params: Readonly<Record<string, unknown>> }) => void) | undefined;
  const request = vi.fn(async (method: string) => {
    if (method === "thread/read") return {
      thread: {
        id: "thread-1", status: { type: current },
        turns: current === "active" ? [{ id: "turn-1", status: "inProgress", items: [] }] : [],
      },
    };
    if (method === "turn/start") return { turn: { id: "turn-new", status: "inProgress", items: [] } };
    if (method === "turn/steer") return { turnId: "turn-1" };
    throw new Error(`unexpected request: ${method}`);
  });
  const backend = new CodexBackend({
    client: {
      request,
      isConnected: () => connected,
      onNotification(handler) { notificationHandler = handler; return () => { notificationHandler = undefined; }; },
    },
    resolveLane: (threadId) => threadId === "thread-1" ? "alpha/design" : undefined,
    hasVisibleClient: () => visibleClient,
  });
  return {
    backend, request,
    setStatus(value: typeof current) { current = value; },
    setConnected(value: boolean) { connected = value; },
    setVisibleClient(value: boolean) { visibleClient = value; },
    emit(method: string, params: Record<string, unknown>) { notificationHandler?.({ method, params }); },
  };
}

describe("CodexBackend", () => {
  it("reports restore presence from the TUI client, not loaded thread state", () => {
    const x = setup("active");
    expect(x.backend.restorePresence(binding)).toBe("offline");
    x.setVisibleClient(true);
    expect(x.backend.restorePresence(binding)).toBe("online");
    x.setConnected(false);
    expect(x.backend.restorePresence(binding)).toBe("unavailable");
  });
  it("starts an idle thread with a body-free mailbox notice", async () => {
    const x = setup("idle");
    await expect(x.backend.notifyNormal(binding, notification)).resolves.toBe("sent");
    expect(x.request.mock.calls.map(([method]) => method)).toEqual(["thread/read", "turn/start"]);
    const start = x.request.mock.calls[1]![1] as { input: Array<{ text: string }> };
    expect(JSON.parse(start.input[0]!.text)).toEqual({
      kind: "lane_router_mailbox", laneAddress: "alpha/design",
      pendingPath: notification.pendingPath, messageIds: ["message-1", "message-2"],
    });
  });

  it("defers busy normal mail but steers a busy correction", async () => {
    const normal = setup("active");
    await expect(normal.backend.notifyNormal(binding, notification)).resolves.toBe("deferred");
    expect(normal.request).toHaveBeenCalledTimes(1);
    const correction = setup("active");
    await expect(correction.backend.notifyCorrection(binding, { ...notification, kind: "correction", messageIds: ["message-2"] }))
      .resolves.toBe("sent");
    expect(correction.request).toHaveBeenLastCalledWith("turn/steer", expect.objectContaining({
      threadId: "thread-1", expectedTurnId: "turn-1",
    }));
  });

  it("reports a lost App Server link and a failed request as different outcomes", async () => {
    const offline = setup("idle");
    offline.setConnected(false);
    await expect(offline.backend.notifyNormal(binding, notification)).resolves.toBe("no_channel");

    const missing = setup("notLoaded");
    await expect(missing.backend.notifyNormal(binding, notification)).resolves.toBe("no_channel");

    const broken = setup("idle");
    broken.request.mockRejectedValueOnce(new Error("App Server refused the request"));
    await expect(broken.backend.notifyNormal(binding, notification)).resolves.toBe("send_failed");
  });

  // lane_directory is what a consumer calls once the link is already suspect, so reachability
  // must come from state already held. A round trip here could hang the query itself.
  it("answers reachability without making any App Server request", async () => {
    const x = setup("idle");
    await x.backend.notifyNormal(binding, notification);
    const requestsAfterNotify = x.request.mock.calls.length;

    expect(x.backend.reach(binding)).toMatchObject({
      state: "unconfirmed", connectedAt: null, lastNotifiedAt: expect.any(Number), believedBusy: null,
    });
    x.emit("turn/completed", { threadId: "thread-1" });
    expect(x.backend.reach(binding)).toMatchObject({ state: "live", lastLifecycleAt: expect.any(Number) });

    expect(x.request.mock.calls.length).toBe(requestsAfterNotify);
  });

  it("reports an unreachable thread once the App Server link is gone", () => {
    const x = setup("idle");
    x.emit("turn/completed", { threadId: "thread-1" });
    x.setConnected(false);
    expect(x.backend.reach(binding)).toEqual({
      state: "no_channel", connectedAt: null, lastLifecycleAt: null, lastNotifiedAt: null, believedBusy: null,
    });
  });

  it("reports turn completion as an attention opportunity", () => {
    const x = setup();
    const handler = vi.fn();
    x.backend.onAttentionOpportunity(handler);
    x.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });
    expect(handler).toHaveBeenCalledWith("alpha/design");
  });

  it("waits for an active turn and treats a missing thread as replaceable", async () => {
    const x = setup("active");
    const waiting = x.backend.waitUntilReplaceable(binding);
    await vi.waitFor(() => expect(x.request).toHaveBeenCalledWith("thread/read", expect.anything()));
    x.setStatus("idle");
    x.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });
    await expect(waiting).resolves.toBeUndefined();

    const missing = setup();
    missing.request.mockRejectedValueOnce(new Error("thread not found"));
    await expect(missing.backend.waitUntilReplaceable(binding)).resolves.toBeUndefined();
  });
});
