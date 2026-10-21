import { afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runLaneMcpStdio } from "../../src/mcp/lane-mcp-server.js";
import { runZcodeLaneMcpStdio } from "../../src/mcp/zcode-lane-mcp-server.js";

const fixture = vi.hoisted(() => ({ transport: undefined as any }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class { constructor() { return fixture.transport; } } }));
vi.mock("../../src/process/ensure-router.js", () => ({ ensureRouter: async () => ({ url: "http://fixture.invalid" }) }));
vi.mock("../../src/process/local-client.js", () => ({
  LocalRouterClient: class { async call(name: string, args: unknown, context: unknown) { return { name, args, context }; } },
  connectClaudeChannel: async () => ({ attach() {}, detach() {}, async close() {} }),
}));
// Importing either stdio product entry must stay pure: these modules open storage only in main.
vi.mock("../../src/modules/issues/index.js", () => { throw new Error("MCP imported module assembly"); });
vi.mock("../../src/modules/issues/store.js", () => { throw new Error("MCP imported SQLite store"); });
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

test.each(["claude", "zcode"] as const)("actual %s stdio entry assembles all sixteen pure tools", async backend => {
  const [a, b] = InMemoryTransport.createLinkedPair(); fixture.transport = b;
  const client = new Client({ name: "stdio-product-consumer", version: "1" });
  const [runtime] = await Promise.all([backend === "claude" ? runLaneMcpStdio() : runZcodeLaneMcpStdio(), client.connect(a)]);
  closers.push(async () => { await client.close(); await runtime.close(); });
  const listed = (await client.listTools()).tools;
  expect(listed.map(tool => tool.name)).toEqual(["lane_directory", "lane_attach_current", "lane_send", "lane_ack", "lane_restore_project", "lane_finish", "lane_issue_publish", "lane_issue_read", "lane_issue_append", "lane_issue_update", "lane_graph_create", "lane_graph_read", "lane_graph_lock", "lane_graph_apply", "lane_kb_search", "lane_kb_record"]);
  const result = await client.callTool({ name: "lane_issue_read", arguments: { issueId: "saved" } });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse((result.content as any)[0].text)).toMatchObject({ name: "lane_issue_read", args: { issueId: "saved" }, context: { backend } });
});
