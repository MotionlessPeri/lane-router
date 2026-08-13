import { expect, test, vi } from "vitest";

import { LANE_TOOL_NAMES } from "../../../src/tools/tool-contract.js";
import { CodexDynamicToolDispatcher, codexDynamicTools, UnknownCodexThreadError } from "../../../src/adapters/codex/dynamic-tools.js";

test("exports exactly five strict shared logical schemas", () => {
  const tools = codexDynamicTools();
  expect(tools.map((tool) => tool.name)).toEqual(LANE_TOOL_NAMES);
  expect(tools).toHaveLength(5);
  for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
  expect(tools.find((tool) => tool.name === "lane_attach_current")?.description).toMatch(/explicit confirmation/i);
});

test("authoritative App Server thread identity and call ID become caller context", async () => {
  const call = vi.fn(() => ({ id: "message-1" }));
  const dispatcher = new CodexDynamicToolDispatcher({ ownsThread: (threadId) => threadId === "thread-1", cwdForThread: () => "D:\\project", call });
  const request = { threadId: "thread-1", turnId: "turn-1", callId: "call-1", tool: "lane_send", arguments: { target: "alpha/test", kind: "normal", body: "x" } } as const;
  const [first, second] = await Promise.all([dispatcher.dispatch(request), dispatcher.dispatch(request)]);
  expect(first).toEqual(second);
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith("lane_send", request.arguments, {
    backend: "codex", conversationId: "thread-1", cwd: "D:\\project", requestKey: 'codex:["thread-1","turn-1","call-1"]',
  });
});

test("tuple request keys cannot collide and completed calls remain bounded", async () => {
  let now = 1_000;
  const call = vi.fn(() => ({ ok: true }));
  const dispatcher = new CodexDynamicToolDispatcher({ ownsThread: () => true, call, now: () => now, completedTtlMs: 10, maxCompletedEntries: 2 });
  const request = (threadId: string, turnId: string, callId: string) => ({ threadId, turnId, callId, tool: "lane_directory", arguments: { project: "alpha" } } as const);
  await dispatcher.dispatch(request("a:b", "c", "d"));
  await dispatcher.dispatch(request("a", "b:c", "d"));
  expect(call).toHaveBeenCalledTimes(2);
  await dispatcher.dispatch(request("a", "b:c", "d"));
  expect(call).toHaveBeenCalledTimes(2);
  now += 11;
  await dispatcher.dispatch(request("a", "b:c", "d"));
  expect(call).toHaveBeenCalledTimes(3);
});

test("rejects a thread not created or resumed by this Router", async () => {
  const call = vi.fn();
  const dispatcher = new CodexDynamicToolDispatcher({ ownsThread: () => false, call });
  await expect(dispatcher.dispatch({ threadId: "foreign", turnId: "t", callId: "c", tool: "lane_directory", arguments: { project: "alpha" } }))
    .rejects.toBeInstanceOf(UnknownCodexThreadError);
  expect(call).not.toHaveBeenCalled();
});
