import { expect, test, vi } from "vitest";
import { LANE_TOOL_NAMES } from "../../../src/tools/tool-contract.js";
import { CodexDynamicToolDispatcher, codexDynamicTools, StaleCodexThreadError } from "../../../src/adapters/codex/dynamic-tools.js";

test("exports exactly eight strict shared logical schemas", () => {
  const tools = codexDynamicTools();
  expect(tools.map((tool) => tool.name)).toEqual(LANE_TOOL_NAMES);
  expect(tools).toHaveLength(8);
  for (const tool of tools) {
    expect(tool.type).toBe("function");
    expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
  }
});

test("authoritative thread binding supplies identity and duplicate calls have one effect", async () => {
  const call = vi.fn(() => ({ lane: "b" }));
  const dispatcher = new CodexDynamicToolDispatcher({
    resolveThread: (threadId) => threadId === "th" ? { bindingId: "binding", generation: 4 } : undefined,
    call,
  });
  const request = { threadId: "th", turnId: "turn", callId: "call", tool: "lane_send", arguments: { operation_id: "spoof", target: "p/b", kind: "normal", body: "x", metadata: {}, actor: "spoof" } } as const;
  const [first, second] = await Promise.all([dispatcher.dispatch(request), dispatcher.dispatch(request)]);
  expect(first).toEqual(second);
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith("lane_send", expect.objectContaining({ operation_id: 'codex:["th","turn","call"]' }), { bindingId: "binding", generation: 4 });
  expect(call.mock.calls[0]?.[1]).not.toHaveProperty("actor");
});

test("tuple encoding cannot collide when identifiers contain colons", async () => {
  const call = vi.fn(() => ({ ok: true }));
  const dispatcher = new CodexDynamicToolDispatcher({ resolveThread: () => ({ bindingId: "binding", generation: 1 }), call });
  await dispatcher.dispatch({ threadId: "a:b", turnId: "c", callId: "d", tool: "lane_status", arguments: {} });
  await dispatcher.dispatch({ threadId: "a", turnId: "b:c", callId: "d", tool: "lane_status", arguments: {} });
  expect(call).toHaveBeenCalledTimes(2);
});

test("completed replay cache expires and remains bounded under 10000 calls", async () => {
  let now = 1_000;
  const call = vi.fn(() => ({ ok: true }));
  const dispatcher = new CodexDynamicToolDispatcher({ resolveThread: () => ({ bindingId: "binding", generation: 1 }), call, now: () => now, completedTtlMs: 50, maxCompletedEntries: 32 });
  const request = (callId: string) => ({ threadId: "th", turnId: "tu", callId, tool: "lane_status", arguments: {} } as const);
  await dispatcher.dispatch(request("ttl"));
  await dispatcher.dispatch(request("ttl"));
  expect(call).toHaveBeenCalledTimes(1);
  now += 51;
  await dispatcher.dispatch(request("ttl"));
  expect(call).toHaveBeenCalledTimes(2);
  for (let index = 0; index < 10_000; index += 1) await dispatcher.dispatch(request(`call-${index}`));
  await dispatcher.dispatch(request("call-0"));
  expect(call).toHaveBeenCalledTimes(10_003);
});

test("duplicate rejected calls share one effect only while inflight and retain a bounded rejection", async () => {
  const failure = new Error("boom");
  const call = vi.fn(async () => { throw failure; });
  const dispatcher = new CodexDynamicToolDispatcher({ resolveThread: () => ({ bindingId: "binding", generation: 1 }), call, maxCompletedEntries: 2 });
  const request = { threadId: "th", turnId: "tu", callId: "failed", tool: "lane_status", arguments: {} } as const;
  const [first, second] = await Promise.allSettled([dispatcher.dispatch(request), dispatcher.dispatch(request)]);
  expect(first.status).toBe("rejected");
  expect(second.status).toBe("rejected");
  await expect(dispatcher.dispatch(request)).rejects.toBe(failure);
  expect(call).toHaveBeenCalledTimes(1);
});

test("stale or unbound threads are rejected without an operation", async () => {
  const call = vi.fn();
  const dispatcher = new CodexDynamicToolDispatcher({ resolveThread: () => undefined, call });
  await expect(dispatcher.dispatch({ threadId: "old", turnId: "t", callId: "c", tool: "lane_status", arguments: {} })).rejects.toBeInstanceOf(StaleCodexThreadError);
  expect(call).not.toHaveBeenCalled();
});
