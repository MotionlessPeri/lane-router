import { expect, test, vi } from "vitest";

import { communicationToolCatalog } from "../../src/application/builtin-tools.js";
import { laneMcpTools } from "../../src/mcp/tool-schemas.js";
import { launchLane } from "../../src/process/lane-launcher.js";
import { LANE_TOOLS, LANE_TOOL_NAMES } from "../../src/tools/tool-contract.js";
import { toolArgsSchemas } from "../../src/tools/tool-schema.js";
import { ToolService } from "../../src/tools/tool-service.js";

// Spec docs/superpowers/specs/2026-10-21-task-lane.md, 4.3 item 1 and acceptance 1: lane_finish
// acts on its caller alone, so it takes no address at all.

test("acceptance 1: lane_finish is a lane tool that takes no argument, so it can only ever mean its caller", () => {
  expect(LANE_TOOL_NAMES).toContain("lane_finish");
  expect(toolArgsSchemas.lane_finish.parse({})).toEqual({});
  for (const other of [{ address: "alpha/task" }, { lane: "alpha/task" }]) expect(() => toolArgsSchemas.lane_finish.parse(other)).toThrow();
  const published = laneMcpTools(communicationToolCatalog).find((tool) => tool.name === "lane_finish");
  expect(published?.inputSchema.properties ?? {}).toEqual({});
});

test("the tool says who may call it, what to settle first and that nothing comes after", () => {
  const description = LANE_TOOLS.find((tool) => tool.name === "lane_finish")?.description ?? "";
  expect(description).toContain("「任务 lane：」");
  expect(description).toMatch(/lane_ack/u);
  expect(description).toMatch(/archive/iu);
  expect(description).toMatch(/no more tools/iu);
});

test("the tool service hands the call to the core with the caller's own context", async () => {
  const finishLane = vi.fn(async () => ({ address: "alpha/task", finishedAt: 5 }));
  const context = { backend: "claude" as const, conversationId: "conv-task", requestKey: "k" };
  await expect(new ToolService({ finishLane } as never).call("lane_finish", {}, context)).resolves.toEqual({ address: "alpha/task", finishedAt: 5 });
  expect(finishLane).toHaveBeenCalledExactlyOnceWith(context);
});

test("lane-router-lane finish calls lane_finish as the conversation it runs in, Codex or Claude, and nothing else", async () => {
  const call = vi.fn(async () => ({ address: "alpha/task", finishedAt: 5 }));
  const written: string[] = [];
  const deps = (env: NodeJS.ProcessEnv) => ({ issueClient: { call }, env, cwd: "D:\\work", write: (text: string) => { written.push(text); } });

  expect(await launchLane(["finish"], deps({ CODEX_THREAD_ID: "thread-1" }) as never)).toBe(0);
  expect(call).toHaveBeenLastCalledWith("lane_finish", {}, expect.objectContaining({ backend: "codex", conversationId: "thread-1", cwd: "D:\\work" }));
  await launchLane(["finish"], deps({ CLAUDE_CODE_SESSION_ID: "session-1", CLAUDE_PID: "4242" }) as never);
  expect(call).toHaveBeenLastCalledWith("lane_finish", {}, expect.objectContaining({ backend: "claude", conversationId: "session-1", joinKey: "4242" }));
  expect(written.at(-1)).toBe(`${JSON.stringify({ address: "alpha/task", finishedAt: 5 })}\n`);

  await expect(launchLane(["finish"], deps({}) as never)).rejects.toThrow(/CODEX_THREAD_ID|CLAUDE_CODE_SESSION_ID/u);
  await expect(launchLane(["finish", "alpha/other"], deps({ CODEX_THREAD_ID: "thread-1" }) as never)).rejects.toThrow(/Usage/u);
  expect(call).toHaveBeenCalledTimes(2);
});
