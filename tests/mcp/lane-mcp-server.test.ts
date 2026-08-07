import { afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createLaneMcpServer, type LaneBrokerClient } from "../../src/mcp/lane-mcp-server.js";
import { ChannelBridge } from "../../src/adapters/claude/channel-bridge.js";
import { LANE_TOOL_NAMES } from "../../src/tools/tool-contract.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

function broker(identity = { bindingId: "binding-a", generation: 4, laneAddress: "p/a", adapter: "claude" as const }) {
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "whoami") return identity;
    if (method === "inbox") return [];
    if (method === "message") return { id: params.messageId, kind: "normal", body: "body", metadata: {}, replyTo: null, createdAt: 1 };
    if (method === "send") return { messageId: "m", deliveryId: "d", sequence: 1 };
    if (method === "claim") return { claimId: "claim", deadline: 10 };
    if (method === "ack") return { id: params.deliveryId, status: "acknowledged" };
    if (method === "park") return { id: params.deliveryId, status: "parked" };
    throw new Error(`unexpected method ${method}`);
  });
  const status = vi.fn(async () => ({ projects: { count: 1 }, lanes: { count: 2 }, pending: { count: 0 }, dispatchFences: { activeCount: 0, affectedLanes: [] } }));
  return { client: { call, status } as unknown as LaneBrokerClient, call, status };
}

async function connected(input = broker()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createLaneMcpServer({ broker: input.client, identity: { bindingId: "binding-a", generation: 4 } });
  const client = new Client({ name: "lane-test", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return { ...input, client, server };
}

test("lane MCP advertises exactly eight logical tools with no caller-controlled identity", async () => {
  const x = await connected();
  const listed = await x.client.listTools();
  expect(listed.tools.map((tool) => tool.name)).toEqual(LANE_TOOL_NAMES);
  for (const tool of listed.tools) {
    expect(tool.inputSchema.properties).not.toHaveProperty("binding_id");
    expect(tool.inputSchema.properties).not.toHaveProperty("generation");
    expect(tool.inputSchema.additionalProperties).toBe(false);
  }

  const spoofed = await x.client.callTool({ name: "lane_send", arguments: { operation_id: "spoof", target: "p/b", kind: "normal", body: "x", metadata: {}, binding_id: "binding-b", generation: 99 } });
  expect(spoofed.isError).toBe(true);
  expect(x.call).not.toHaveBeenCalledWith("send", expect.anything());
});

test("lane MCP derives identity from its credential and propagates operation IDs", async () => {
  const x = await connected();
  const calls = [
    ["lane_whoami", {}],
    ["lane_status", {}],
    ["lane_send", { operation_id: "op-send", target: "p/b", kind: "normal", body: "hello", metadata: {}, reply_to: "m0" }],
    ["lane_inbox_list", {}],
    ["lane_message_get", { message_id: "m1" }],
    ["lane_message_claim", { operation_id: "op-claim", delivery_id: "d1", claim_id: "c1" }],
    ["lane_message_ack", { operation_id: "op-ack", delivery_id: "d1", claim_id: "c1", outcome: { kind: "rejected", reason: "done elsewhere" } }],
    ["lane_message_park", { operation_id: "op-park", delivery_id: "d2", reason: "poison" }],
  ] as const;
  for (const [name, args] of calls) expect((await x.client.callTool({ name, arguments: args })).isError).not.toBe(true);

  expect(x.call).toHaveBeenCalledWith("send", expect.objectContaining({ operationId: "op-send", replyTo: "m0" }));
  expect(x.call).toHaveBeenCalledWith("claim", { operationId: "op-claim", deliveryId: "d1", claimId: "c1" });
  expect(x.call).toHaveBeenCalledWith("ack", expect.objectContaining({ operationId: "op-ack", deliveryId: "d1", claimId: "c1" }));
  expect(x.call).toHaveBeenCalledWith("park", { operationId: "op-park", deliveryId: "d2", reason: "poison" });
  expect(x.status).toHaveBeenCalledOnce();
});

test("lane MCP refuses a stale fixed generation before exposing tools", async () => {
  const stale = broker({ bindingId: "binding-a", generation: 5, laneAddress: "p/a", adapter: "claude" });
  const [, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createLaneMcpServer({ broker: stale.client, identity: { bindingId: "binding-a", generation: 4 } });
  await expect(server.connect(serverTransport)).rejects.toThrow(/generation|identity|stale/i);
  await server.close();
});

test("lane MCP advertises Channel capability, forwards wakes, and tracks disconnect", async () => {
  const x = broker();
  const channel = new ChannelBridge();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createLaneMcpServer({ broker: x.client, identity: { bindingId: "binding-a", generation: 4 }, channel });
  const client = new Client({ name: "channel-test", version: "1" }, { capabilities: {} });
  const notifications: unknown[] = [];
  client.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel"), params: z.object({ content: z.string(), meta: z.record(z.string(), z.unknown()) }) }), async (notification) => { notifications.push(notification); });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
  expect(await channel.wake({ deliveryId: "d", messageId: "m", targetLaneId: "p/a", sequence: 1, kind: "normal", bindingGeneration: 4 })).toBe("started_new_turn");
  await vi.waitFor(() => expect(notifications).toHaveLength(1));
  await client.callTool({ name: "lane_message_ack", arguments: { operation_id: "ack", delivery_id: "d", claim_id: "c", outcome: { kind: "rejected", reason: "fixture" } } });
  expect(channel.getRuntimeState()).toEqual({ availability: "online", turn: "idle" });
  await client.close();
  await vi.waitFor(() => expect(channel.getRuntimeState()).toEqual({ availability: "offline", turn: "unknown" }));
  await server.close();
});
