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
