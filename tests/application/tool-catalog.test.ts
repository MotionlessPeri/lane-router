import { expect, test, vi } from "vitest";
import { z } from "zod";

import { ToolCatalog } from "../../src/application/tool-catalog.js";
import { communicationToolCatalog, productToolCatalog, bindBuiltinTools } from "../../src/application/builtin-tools.js";
import { LANE_TOOL_NAMES } from "../../src/tools/tool-contract.js";

test("one catalog publishes, validates and dispatches its composed definitions", async () => {
  const definition = { name: "extra", description: "Extra", schema: z.object({ value: z.string() }).strict() };
  const catalog = new ToolCatalog([...communicationToolCatalog.definitions, definition]);
  const handler = vi.fn((_name, args) => args);
  const tools = catalog.bind(handler);
  expect(catalog.definitions.map(tool => tool.name)).toEqual([...LANE_TOOL_NAMES, "extra"]);
  await expect(tools.call("extra", { value: "hello" }, { backend: "codex", conversationId: "thread" })).resolves.toEqual({ value: "hello" });
  await expect(tools.call("extra", { value: "hello", owner: "spoof" }, { backend: "codex", conversationId: "thread" })).rejects.toThrow();
  await expect(tools.call("missing", {}, { backend: "codex", conversationId: "thread" })).rejects.toThrow(/Unknown/);
  expect(handler).toHaveBeenCalledOnce();
  expect(() => new ToolCatalog([definition, definition])).toThrow(/Duplicate/);
});

test("product adds four issues while communication arguments, signal and takeover option pass through", async () => {
  const call = vi.fn(async () => "base");
  const tools = bindBuiltinTools({ call } as never);
  const context = { backend: "codex", conversationId: "thread" } as const;
  const signal = new AbortController().signal;
  expect(productToolCatalog.definitions.map(tool => tool.name)).toEqual([...LANE_TOOL_NAMES, "lane_issue_publish", "lane_issue_read", "lane_issue_append", "lane_issue_update"]);
  expect(communicationToolCatalog.definitions.map(tool => tool.name)).toEqual(LANE_TOOL_NAMES);
  await expect(tools.call("lane_attach_current", { address: "p/a" }, context, signal, { rejectTakeover: true })).resolves.toBe("base");
  expect(call).toHaveBeenCalledWith("lane_attach_current", { address: "p/a" }, context, signal, { rejectTakeover: true });
  await expect(tools.call("lane_issue_read", {}, context)).rejects.toThrow(/ISSUES_UNAVAILABLE/);
});
