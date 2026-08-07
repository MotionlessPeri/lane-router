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
  expect(call).toHaveBeenCalledWith("lane_send", expect.objectContaining({ operation_id: "codex:th:turn:call" }), { bindingId: "binding", generation: 4 });
  expect(call.mock.calls[0]?.[1]).not.toHaveProperty("actor");
});

test("stale or unbound threads are rejected without an operation", async () => {
  const call = vi.fn();
  const dispatcher = new CodexDynamicToolDispatcher({ resolveThread: () => undefined, call });
  await expect(dispatcher.dispatch({ threadId: "old", turnId: "t", callId: "c", tool: "lane_status", arguments: {} })).rejects.toBeInstanceOf(StaleCodexThreadError);
  expect(call).not.toHaveBeenCalled();
});
