import { expect, test, vi } from "vitest";
import { ClaudeAdapter } from "../../../src/adapters/claude/claude-adapter.js";
import type { AdapterDeliveryRequest } from "../../../src/core/adapter-contract.js";

const request: AdapterDeliveryRequest = { deliveryId: "d", messageId: "m", targetLaneId: "p/a", sequence: 1, kind: "normal", bindingGeneration: 2 };

test("Claude adapter maps missing, offline, idle, and busy bindings honestly", async () => {
  const channels = {
    getRuntimeState: vi.fn(() => ({ availability: "offline" as const, turn: "unknown" as const })),
    deliver: vi.fn(async () => "stored_pending" as const),
  };
  const missing = new ClaudeAdapter({ resolveBinding: () => undefined, channels });
  expect(await missing.deliver(request)).toBe("binding_not_found");
  const adapter = new ClaudeAdapter({ resolveBinding: () => ({ bindingId: "binding-a" }), channels });
  expect(await adapter.deliver(request)).toBe("stored_pending");
  channels.getRuntimeState.mockReturnValue({ availability: "online", turn: "idle" });
  channels.deliver.mockResolvedValueOnce("started_new_turn");
  expect(await adapter.deliver(request)).toBe("started_new_turn");
  channels.getRuntimeState.mockReturnValue({ availability: "online", turn: "busy" });
  channels.deliver.mockResolvedValueOnce("queued_next_turn");
  expect(await adapter.deliver({ ...request, deliveryId: "d2", messageId: "m2" })).toBe("queued_next_turn");
  expect(await adapter.getRuntimeState(request)).toEqual({ availability: "online", turn: "busy" });
  expect(channels.deliver).toHaveBeenCalledWith("binding-a", 2, expect.objectContaining({ messageId: "m" }));
});

test("Claude adapter retries rather than notifying after a binding generation changes", async () => {
  const channels = { getRuntimeState: vi.fn(() => ({ availability: "online" as const, turn: "idle" as const })), deliver: vi.fn(async () => "started_new_turn" as const) };
  let calls = 0;
  const adapter = new ClaudeAdapter({ resolveBinding: () => ++calls === 1 ? { bindingId: "binding-a" } : undefined, channels });
  expect(await adapter.deliver(request)).toBe("binding_changed_retry");
  expect(channels.deliver).not.toHaveBeenCalled();
});
