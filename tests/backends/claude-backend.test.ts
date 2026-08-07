import { describe, expect, it, vi } from "vitest";

import { ClaudeBackend, type ClaudeChannelPort } from "../../src/backends/claude-backend.js";
import type { BindingRecord } from "../../src/router/types.js";

const binding: BindingRecord = {
  id: "binding-1", laneAddress: "alpha/design", backend: "claude", conversationId: "session-1",
  generation: 1, startup: {}, activeAt: 1, inactiveAt: null,
};
const notification = {
  laneAddress: "alpha/design", pendingPath: "C:/mailboxes/alpha/design/pending",
  kind: "normal" as const, messageIds: ["message-1"],
};

function setup(result: "started_new_turn" | "queued_next_turn" | "offline" = "started_new_turn") {
  let attention: ((binding: BindingRecord) => void) | undefined;
  const channel: ClaudeChannelPort = {
    notify: vi.fn(async () => result),
    waitUntilReplaceable: vi.fn(async () => undefined),
    onAttentionOpportunity(handler) { attention = handler; return () => { attention = undefined; }; },
  };
  return { backend: new ClaudeBackend(channel), channel, emit: () => attention?.(binding) };
}

describe("ClaudeBackend", () => {
  it("uses the same Channel notification for normal and correction messages", async () => {
    const x = setup("queued_next_turn");
    await expect(x.backend.notifyNormal(binding, notification)).resolves.toBe("delivered");
    await expect(x.backend.notifyCorrection(binding, { ...notification, kind: "correction" })).resolves.toBe("delivered");
    expect(x.channel.notify).toHaveBeenCalledTimes(2);
    expect(x.channel.notify).toHaveBeenNthCalledWith(2, binding, expect.objectContaining({ kind: "correction" }));
  });

  it("maps a disconnected Channel to pending and delegates safe replacement", async () => {
    const x = setup("offline");
    await expect(x.backend.notifyNormal(binding, notification)).resolves.toBe("offline");
    await x.backend.waitUntilReplaceable(binding);
    expect(x.channel.waitUntilReplaceable).toHaveBeenCalledWith(binding);
  });

  it("forwards reconnect and turn-end attention without exposing busy/idle state", () => {
    const x = setup();
    const handler = vi.fn();
    x.backend.onAttentionOpportunity(handler);
    x.emit();
    expect(handler).toHaveBeenCalledWith("alpha/design");
    expect(x.backend).not.toHaveProperty("getRuntimeState");
  });
});
