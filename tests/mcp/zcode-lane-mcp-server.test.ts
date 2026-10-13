import { afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { claudeJoinKey, type LaneRouterClient } from "../../src/mcp/lane-mcp-server.js";
import { createZcodeLaneMcpServer, zcodeJoinKey, zcodeMcpProfile } from "../../src/mcp/zcode-lane-mcp-server.js";
import { LANE_TOOL_NAMES } from "../../src/tools/tool-contract.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

async function connected() {
  const call = vi.fn(async (name: string) => name === "lane_directory" ? [] : { ok: true });
  const router = { call } as unknown as LaneRouterClient;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createZcodeLaneMcpServer({ router, conversationId: "zcode-session-1", cwd: "D:\\project", joinKey: "4242", newRequestKey: () => "call-1" });
  const client = new Client({ name: "lane-test", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return { client, call };
}

test("handshakes after initialization and advertises exactly the five strict tools", async () => {
  const x = await connected();
  const listed = await x.client.listTools();
  expect(listed.tools.map((tool) => tool.name)).toEqual(LANE_TOOL_NAMES);
  expect(listed.tools).toHaveLength(5);
  for (const tool of listed.tools) expect(tool.inputSchema.additionalProperties).toBe(false);
});

test("injects the zcode backend and an internal request key under its own prefix", async () => {
  const x = await connected();
  const result = await x.client.callTool({ name: "lane_send", arguments: { target: "alpha/test", body: "hello", kind: "normal" } });
  expect(result.isError).not.toBe(true);
  expect(x.call).toHaveBeenCalledWith("lane_send", { target: "alpha/test", body: "hello", kind: "normal" }, {
    backend: "zcode", conversationId: "zcode-session-1", cwd: "D:\\project", joinKey: "4242", requestKey: "zcode:call-1",
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

test("joins on the shared parent pid and never on an inherited CLAUDE_PID", () => {
  expect(zcodeJoinKey(4242)).toBe("4242");
  expect(zcodeMcpProfile(4242).joinKey()).toBe("4242");
  // The contrast is the contract: the Claude entry prefers the env value, and a zcode process that
  // inherited it would join itself to some Claude session's identity if this entry reused that.
  expect(claudeJoinKey({ CLAUDE_PID: "999" })).toBe("999");
  expect(zcodeJoinKey(4242)).not.toBe(claudeJoinKey({ CLAUDE_PID: "999" }));
});

test("starts under a fresh UUID conversation id, which only the join can re-key", () => {
  const profile = zcodeMcpProfile();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  expect(profile.conversationId()).toMatch(uuid);
  expect(profile.conversationId()).not.toBe(profile.conversationId());
  expect(profile.backend).toBe("zcode");
});
