import { describe, expect, it, vi } from "vitest";

import { ZcodeBackend, type ZcodeDriverSessionPort } from "../../src/backends/zcode-backend.js";
import type { ClaudeChannelOutcome, ClaudeChannelPort } from "../../src/backends/claude-backend.js";
import { notificationPayload } from "../../src/router/notification-payload.js";
import type { BindingRecord, NotificationOutcome, ReachSnapshot } from "../../src/router/types.js";

const binding: BindingRecord = {
  id: "binding-1", laneAddress: "alpha/design", backend: "zcode", conversationId: "session-1",
  generation: 1, startup: {}, activeAt: 1, inactiveAt: null, cwd: null,
};
const drivenBinding: BindingRecord = { ...binding, conversationId: "sess-headless" };
const notification = {
  laneAddress: "alpha/design", pendingPath: "C:/mailboxes/alpha/design/pending",
  kind: "normal" as const, messageIds: ["message-1"],
  messages: [{ id: "message-1", sender: "alpha/hub", summary: "本轮 lane 重构的顺序" }],
};
const live: ReachSnapshot = {
  state: "live", connectedAt: 10, lastLifecycleAt: 20, lastNotifiedAt: 30, believedBusy: false,
};

function setup(result: ClaudeChannelOutcome = "sent", reach: ReachSnapshot = live) {
  let attention: ((binding: BindingRecord) => void) | undefined;
  const channel: ClaudeChannelPort = {
    notify: vi.fn(async () => result),
    waitUntilReplaceable: vi.fn(async () => undefined),
    onAttentionOpportunity(handler) { attention = handler; return () => { attention = undefined; }; },
    reach: vi.fn(() => reach),
    resolveIdentity: vi.fn((context: { conversationId: string }) => ({ value: context.conversationId, source: "caller" as const })),
  };
  return { backend: new ZcodeBackend(channel), channel, emit: () => attention?.(binding) };
}

function driverPort(overrides: Partial<ZcodeDriverSessionPort> = {}): ZcodeDriverSessionPort {
  return {
    hasSession: (sessionId) => sessionId === drivenBinding.conversationId,
    send: vi.fn(async (): Promise<NotificationOutcome> => "sent"),
    waitUntilIdle: vi.fn(async () => undefined),
    sessionSnapshot: () => ({ busy: false, createdAt: 5, lastLifecycleAt: 6, lastNotifiedAt: 7 }),
    onTurnSettled: () => () => undefined,
    ...overrides,
  };
}

describe("ZcodeBackend", () => {
  it("speaks its own backend name while riding the Claude channel port", () => {
    expect(setup().backend.name).toBe("zcode");
  });

  it("treats any open lifecycle channel as online for restore", () => {
    expect(setup("sent", { ...live, state: "unconfirmed", lastLifecycleAt: null }).backend.restorePresence(binding)).toBe("online");
    expect(setup("no_channel", { ...live, state: "no_channel", connectedAt: null }).backend.restorePresence(binding)).toBe("offline");
  });

  it("uses the same Channel notification for normal and correction messages", async () => {
    const x = setup();
    await expect(x.backend.notifyNormal(binding, notification)).resolves.toBe("sent");
    await expect(x.backend.notifyCorrection(binding, { ...notification, kind: "correction" })).resolves.toBe("sent");
    expect(x.channel.notify).toHaveBeenCalledTimes(2);
    expect(x.channel.notify).toHaveBeenNthCalledWith(2, binding, expect.objectContaining({ kind: "correction" }));
  });

  it("reports each channel outcome as itself instead of folding them into one", async () => {
    for (const outcome of ["sent", "no_channel", "send_failed"] as const) {
      const x = setup(outcome);
      await expect(x.backend.notifyNormal(binding, notification)).resolves.toBe(outcome);
    }
  });

  it("delegates safe replacement and reachability to the channel", async () => {
    const x = setup("no_channel", { ...live, state: "unconfirmed", lastLifecycleAt: null });
    await x.backend.waitUntilReplaceable(binding);
    expect(x.channel.waitUntilReplaceable).toHaveBeenCalledWith(binding, undefined);
    expect(x.backend.reach(binding)).toMatchObject({ state: "unconfirmed", lastLifecycleAt: null });
    expect(x.channel.reach).toHaveBeenCalledWith("session-1");
  });

  it("forwards reconnect and turn-end attention without exposing busy/idle state", () => {
    const x = setup();
    const handler = vi.fn();
    x.backend.onAttentionOpportunity(handler);
    x.emit();
    expect(handler).toHaveBeenCalledWith("alpha/design");
    expect(x.backend).not.toHaveProperty("getRuntimeState");
  });

  it("allows attach only after the stable identity joins a live busy lifecycle channel", () => {
    const x = setup("sent", { ...live, believedBusy: true });
    expect(x.backend.validateAttach({ backend: "zcode", conversationId: "mcp", requestKey: "r" }))
      .toMatch(/identity.*not joined/i);

    vi.mocked(x.channel.resolveIdentity).mockReturnValue({ value: "conversation", source: "joined" });
    expect(x.backend.validateAttach({ backend: "zcode", conversationId: "mcp", requestKey: "r" })).toBeUndefined();
    expect(x.channel.reach).toHaveBeenCalledWith("conversation");
  });
});

describe("ZcodeBackend driver sessions", () => {
  it("delivers notifications to a driven session as a send of the payload text, never via the channel", async () => {
    const x = setup();
    const driver = driverPort();
    const backend = new ZcodeBackend(x.channel, driver, () => "alpha/design");
    await expect(backend.notifyNormal(drivenBinding, notification)).resolves.toBe("sent");
    await expect(backend.notifyCorrection(drivenBinding, { ...notification, kind: "correction" })).resolves.toBe("sent");
    expect(driver.send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(driver.send)).toHaveBeenNthCalledWith(1, drivenBinding.conversationId, notificationPayload(notification));
    // The correction is marked inside the payload itself — the driver gets one text surface.
    const correctionText = vi.mocked(driver.send).mock.calls[1]![1]!;
    expect(JSON.parse(correctionText).messageKind).toBe("correction");
    expect(x.channel.notify).not.toHaveBeenCalled();
  });

  it("falls back to the channel for conversations the driver does not own", async () => {
    const x = setup();
    const driver = driverPort();
    const backend = new ZcodeBackend(x.channel, driver, () => "alpha/design");
    await expect(backend.notifyNormal(binding, notification)).resolves.toBe("sent");
    expect(driver.send).not.toHaveBeenCalled();
    expect(x.channel.notify).toHaveBeenCalledWith(binding, notification);
  });

  it("reports reach, replaceability and restore presence from the driver's own state", async () => {
    const x = setup();
    const driver = driverPort({
      sessionSnapshot: () => ({ busy: true, createdAt: 99, lastLifecycleAt: 100, lastNotifiedAt: 101 }),
    });
    const backend = new ZcodeBackend(x.channel, driver, () => "alpha/design");
    expect(backend.reach(drivenBinding)).toEqual({
      state: "live", connectedAt: 99, lastLifecycleAt: 100, lastNotifiedAt: 101, believedBusy: true,
    });
    const signal = AbortSignal.timeout(1_000);
    await backend.waitUntilReplaceable(drivenBinding, signal);
    expect(driver.waitUntilIdle).toHaveBeenCalledWith(drivenBinding.conversationId, signal);
    expect(x.channel.waitUntilReplaceable).not.toHaveBeenCalled();
    expect(backend.restorePresence(drivenBinding)).toBe("online");
  });

  it("reports an unsettled driven session as unconfirmed the way a fresh channel is", () => {
    const x = setup();
    const driver = driverPort({ sessionSnapshot: () => ({ busy: false, createdAt: 1, lastLifecycleAt: null, lastNotifiedAt: null }) });
    const backend = new ZcodeBackend(x.channel, driver, () => "alpha/design");
    expect(backend.reach(drivenBinding)).toMatchObject({ state: "unconfirmed", believedBusy: false });
  });

  it("vouches for attach and a caller-source identity when the driver owns the session", () => {
    const x = setup("sent", { ...live, believedBusy: true });
    const backend = new ZcodeBackend(x.channel, driverPort(), () => "alpha/design");
    const context = { backend: "zcode" as const, conversationId: drivenBinding.conversationId, requestKey: "r" };
    expect(backend.validateAttach(context)).toBeUndefined();
    expect(backend.resolveIdentity(context)).toEqual({ value: drivenBinding.conversationId, source: "caller" });
    // An interactive session still needs its channel join.
    expect(backend.validateAttach({ ...context, conversationId: "session-1" })).toMatch(/not joined/i);
  });

  it("turns a driver turn settlement into an attention opportunity for the lane", () => {
    const x = setup();
    let settled: ((sessionId: string) => void) | undefined;
    const driver = driverPort({ onTurnSettled: (handler) => { settled = handler; return () => { settled = undefined; }; } });
    const backend = new ZcodeBackend(x.channel, driver, (sessionId) => sessionId === drivenBinding.conversationId ? "alpha/design" : undefined);
    const handler = vi.fn();
    backend.onAttentionOpportunity(handler);
    settled?.(drivenBinding.conversationId);
    expect(handler).toHaveBeenCalledWith("alpha/design");
    // A session with no lane binding yet settles silently.
    settled?.("sess-orphan");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
