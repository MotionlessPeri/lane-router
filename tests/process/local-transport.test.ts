import { expect, test, vi } from "vitest";

import { connectClaudeChannel, LocalRouterClient } from "../../src/process/local-client.js";
import { ClaudeChannelHub, LocalRouterServer } from "../../src/process/local-server.js";
import type { BindingRecord } from "../../src/router/types.js";

test("serves health, four lane calls, and the two launcher-only Codex operations on loopback", async () => {
  const tools = { call: vi.fn(async (name: string) => ({ name })) };
  const codex = {
    createThread: vi.fn(async () => "thread-new"),
    resumeThread: vi.fn(async (threadId: string) => threadId),
    endpoint: "ws://127.0.0.1:45000",
  };
  const server = new LocalRouterServer({ tools: tools as never, codex, instanceId: "instance-1" });
  const discovery = await server.start();
  try {
    expect(discovery.url).toMatch(/^http:\/\/127\.0\.0\.1:/u);
    const client = new LocalRouterClient(discovery.url);
    await expect(client.health()).resolves.toMatchObject({ instanceId: "instance-1", codexEndpoint: codex.endpoint });
    await expect(client.call("lane_directory", { project: "alpha" }, {
      backend: "claude", conversationId: "session-1", requestKey: "request-1",
    })).resolves.toEqual({ name: "lane_directory" });
    expect(tools.call).toHaveBeenCalledWith("lane_directory", { project: "alpha" }, {
      backend: "claude", conversationId: "session-1", requestKey: "request-1",
    });
    await expect(client.createCodexThread("C:/project")).resolves.toBe("thread-new");
    await expect(client.resumeCodexThread("thread-old")).resolves.toBe("thread-old");
  } finally { await server.close(); }
});

test("rejects non-loopback binding configuration and unknown RPC methods", async () => {
  expect(() => new LocalRouterServer({ tools: {} as never, codex: {} as never, instanceId: "x", host: "0.0.0.0" })).toThrow(/loopback/i);
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex: { endpoint: "ws://127.0.0.1:1", createThread: vi.fn(), resumeThread: vi.fn() }, instanceId: "x" });
  const discovery = await server.start();
  try {
    const response = await fetch(`${discovery.url}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "unknown_tool", params: {}, context: {} }) });
    expect(response.status).toBe(400);
  } finally { await server.close(); }
});

test("bridges body-free Claude notifications and waits for lifecycle Stop before replacement", async () => {
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex: { endpoint: "ws://127.0.0.1:1", createThread: vi.fn(), resumeThread: vi.fn() }, instanceId: "x" });
  const discovery = await server.start();
  const channel = await connectClaudeChannel(discovery.url, "session-1");
  const notifications: unknown[] = [];
  channel.attach({ notification: async (value) => { notifications.push(value); } });
  const binding: BindingRecord = { id: "binding-1", laneAddress: "alpha/design", backend: "claude", conversationId: "session-1", generation: 1, startup: {}, activeAt: 1, inactiveAt: null };
  const notification = { laneAddress: "alpha/design", pendingPath: "C:/mailbox/pending", kind: "normal" as const, messageIds: ["message-1"] };
  try {
    await expect(server.claude.notify(binding, notification)).resolves.toBe("started_new_turn");
    await expect(server.claude.notify(binding, notification)).resolves.toBe("queued_next_turn");
    await vi.waitFor(() => expect(notifications).toHaveLength(2));
    expect(JSON.stringify(notifications)).not.toContain("message body");
    let replaced = false;
    const waiting = server.claude.waitUntilReplaceable(binding).then(() => { replaced = true; });
    await Promise.resolve();
    expect(replaced).toBe(false);
    expect(server.claude.reportLifecycle("session-1", "Stop")).toBe(true);
    await waiting;
    expect(replaced).toBe(true);
  } finally { await channel.close(); await server.close(); }
});

test("a Claude reconnect after Router restart resolves its durable binding and emits attention", async () => {
  const binding: BindingRecord = { id: "binding-1", laneAddress: "alpha/design", backend: "claude", conversationId: "session-1", generation: 1, startup: {}, activeAt: 1, inactiveAt: null };
  const hub = new ClaudeChannelHub((conversationId) => conversationId === "session-1" ? binding : undefined);
  const attention: string[] = [];
  hub.onAttentionOpportunity((current) => { attention.push(current.laneAddress); });
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex: { endpoint: "ws://127.0.0.1:1", createThread: vi.fn(), resumeThread: vi.fn() }, instanceId: "x", claude: hub });
  const discovery = await server.start();
  const channel = await connectClaudeChannel(discovery.url, "session-1");
  try { await vi.waitFor(() => expect(attention).toEqual(["alpha/design"])); }
  finally { await channel.close(); await server.close(); }
});
