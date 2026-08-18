import { describe, expect, it, vi } from "vitest";

import { ClaudeBackend, type ClaudeChannelOutcome, type ClaudeChannelPort } from "../../src/backends/claude-backend.js";
import type { BindingRecord, ReachSnapshot } from "../../src/router/types.js";

const binding: BindingRecord = {
  id: "binding-1", laneAddress: "alpha/design", backend: "claude", conversationId: "session-1",
  generation: 1, startup: {}, activeAt: 1, inactiveAt: null, cwd: null,
};
const notification = {
  laneAddress: "alpha/design", pendingPath: "C:/mailboxes/alpha/design/pending",
  kind: "normal" as const, messageIds: ["message-1"],
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
  return { backend: new ClaudeBackend(channel), channel, emit: () => attention?.(binding) };
}

describe("ClaudeBackend", () => {
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
    expect(x.backend.validateAttach({ backend: "claude", conversationId: "mcp", requestKey: "r" }))
      .toMatch(/identity.*not joined/i);

    vi.mocked(x.channel.resolveIdentity).mockReturnValue({ value: "conversation", source: "joined" });
    expect(x.backend.validateAttach({ backend: "claude", conversationId: "mcp", requestKey: "r" })).toBeUndefined();
    expect(x.channel.reach).toHaveBeenLastCalledWith("conversation");
  });
});
