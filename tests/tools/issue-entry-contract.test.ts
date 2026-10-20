import { afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { productToolCatalog } from "../../src/application/builtin-tools.js";
import { createLaneMcpServer } from "../../src/mcp/lane-mcp-server.js";
import { codexDynamicTools, CodexDynamicToolDispatcher } from "../../src/adapters/codex/dynamic-tools.js";
import { CodexRuntime } from "../../src/adapters/codex/codex-runtime.js";
import { LANE_ROUTER_INSTRUCTIONS } from "../../src/tools/tool-contract.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

test.each(["claude", "zcode"] as const)("%s MCP lists SDK-valid product tools and calls the same catalog", async backend => {
  const call = vi.fn(async () => ({ ok: true }));
  const server = createLaneMcpServer({ router: { call }, backend, conversationId: "session", catalog: productToolCatalog });
  const client = new Client({ name: "issue-consumer", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  closers.push(async () => { await client.close(); await server.close(); });
  const listed = (await client.listTools()).tools;
  expect(listed.map(tool => tool.name)).toEqual(productToolCatalog.definitions.map(tool => tool.name));
  expect(listed).toHaveLength(13);
  expect((await client.callTool({ name: "lane_issue_read", arguments: { issueId: "saved" } })).isError).not.toBe(true);
  expect(call).toHaveBeenCalledWith("lane_issue_read", { issueId: "saved" }, expect.objectContaining({ backend, conversationId: "session" }));
  expect((await client.callTool({ name: "lane_issue_read", arguments: { issueId: "saved", generation: 2 } })).isError).toBe(true);
  expect(call).toHaveBeenCalledOnce();
});

test("Codex product publication and dispatcher use the same catalog with authoritative identity", async () => {
  const call = vi.fn(async () => ({ ok: true }));
  const tools = codexDynamicTools(productToolCatalog);
  expect(tools.map(tool => tool.name)).toEqual(productToolCatalog.definitions.map(tool => tool.name));
  const dispatcher = new CodexDynamicToolDispatcher({ ownsThread: id => id === "owned", call, catalog: productToolCatalog });
  const request = { threadId: "owned", turnId: "turn", callId: "call", tool: "lane_issue_read", arguments: { issueId: "saved" } };
  await Promise.all([dispatcher.dispatch(request), dispatcher.dispatch(request)]);
  await dispatcher.dispatch(request);
  expect(call).toHaveBeenCalledOnce();
  await expect(dispatcher.dispatch({ ...request, callId: "spoof", arguments: { issueId: "saved", backend: "other" } })).rejects.toThrow();
  await expect(dispatcher.dispatch({ ...request, callId: "unknown", tool: "missing" })).rejects.toThrow(/Unknown/);
});

test("real Codex runtime uses its supplied catalog for thread decoration and dispatch with a fake process", async () => {
  const callTool = vi.fn(async () => ({ ok: true }));
  const runtime = new CodexRuntime({
    core: { callTool, ownsThread: async () => false, event: () => undefined },
    catalog: productToolCatalog,
    process: { client: { onNotification: () => () => {} }, start: () => { throw new Error("fixture process must not start"); } } as never,
  });
  const decorated = runtime.decorateThreadStart({ cwd: "fixture" });
  // The product catalog's instructions: the communication rules, then the issues rules.
  expect(decorated).toMatchObject({ cwd: "fixture", developerInstructions: productToolCatalog.instructions });
  expect(decorated.developerInstructions).toMatch(new RegExp(`^${LANE_ROUTER_INSTRUCTIONS.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n\\nIssues `, "u"));
  expect((decorated.dynamicTools as any[]).map(tool => tool.name)).toEqual(productToolCatalog.definitions.map(tool => tool.name));
  runtime.claimThread("owned", "fixture");
  await runtime.dispatchTool({ threadId: "owned", turnId: "turn", callId: "call", tool: "lane_issue_read", arguments: { issueId: "saved" } });
  expect(callTool).toHaveBeenCalledWith("lane_issue_read", { issueId: "saved" }, expect.objectContaining({ conversationId: "owned", cwd: "fixture" }));
});
