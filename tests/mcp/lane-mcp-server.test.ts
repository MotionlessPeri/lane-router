import { afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createLaneMcpServer, type LaneRouterClient } from "../../src/mcp/lane-mcp-server.js";
import { LANE_TOOL_NAMES } from "../../src/tools/tool-contract.js";
import { LANE_MCP_TOOLS } from "../../src/mcp/tool-schemas.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

async function connected() {
  const call = vi.fn(async (name: string) => name === "lane_directory" ? [] : { ok: true });
  const router = { call } as unknown as LaneRouterClient;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createLaneMcpServer({ router, conversationId: "claude-session-1", cwd: "D:\\project", newRequestKey: () => "call-1" });
  const client = new Client({ name: "lane-test", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return { client, call };
}

test("advertises exactly five strict tools with the shared attach confirmation", async () => {
  const x = await connected();
  const listed = await x.client.listTools();
  expect(listed.tools.map((tool) => tool.name)).toEqual(LANE_TOOL_NAMES);
  expect(listed.tools).toHaveLength(5);
  expect(listed.tools.find((tool) => tool.name === "lane_attach_current")?.description).toMatch(/explicit confirmation/i);
  for (const tool of listed.tools) {
    expect(tool.inputSchema.additionalProperties).toBe(false);
    for (const forbidden of ["conversation_id", "binding_id", "generation", "credential", "operation_id", "admin", "confirmed"])
      expect(tool.inputSchema.properties).not.toHaveProperty(forbidden);
  }
  expect(LANE_MCP_TOOLS.map((tool) => tool.description)).toEqual(listed.tools.map((tool) => tool.description));
});

test("injects the current Claude connection identity and an internal request key", async () => {
  const x = await connected();
  const result = await x.client.callTool({ name: "lane_send", arguments: { target: "alpha/test", body: "hello", kind: "normal" } });
  expect(result.isError).not.toBe(true);
  expect(x.call).toHaveBeenCalledWith("lane_send", { target: "alpha/test", body: "hello", kind: "normal" }, {
    backend: "claude", conversationId: "claude-session-1", cwd: "D:\\project", requestKey: "claude:call-1",
  });
});

test("rejects caller-controlled identity and confirmation fields", async () => {
  const x = await connected();
  for (const [name, args] of [
    ["lane_directory", { project: "alpha", conversation_id: "spoof" }],
    ["lane_attach_current", { address: "alpha/design", confirmed: true }],
  ] as const) expect((await x.client.callTool({ name, arguments: args })).isError).toBe(true);
  expect(x.call).not.toHaveBeenCalled();
});
