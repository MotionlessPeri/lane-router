import { expect, test, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { connectClaudeChannel, LocalRouterClient, probeRouterHealth } from "../../src/process/local-client.js";
import { ClaudeChannelHub, LocalRouterServer } from "../../src/process/local-server.js";
import type { BindingRecord } from "../../src/router/types.js";

test("the Codex TUI bridge injects Router tools into TUI-created threads", async () => {
  const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => upstreamServer.once("listening", resolve));
  const address = upstreamServer.address();
  if (typeof address === "string" || address === null) throw new Error("missing upstream address");
  const upstreamEndpoint = `ws://127.0.0.1:${address.port}`;
  const claimed: string[] = [];
  const codex = {
    endpoint: upstreamEndpoint,
    decorateThreadStart: (params: Record<string, unknown>) => ({ ...params, dynamicTools: [{ name: "lane_directory" }], developerInstructions: "router instructions" }),
    claimThread: (threadId: string) => { claimed.push(threadId); },
    ownsThread: (threadId: string) => threadId === "thread-new",
    dispatchTool: vi.fn(async () => ({ success: true, contentItems: [{ type: "inputText", text: "ok" }] })),
    observeNotification: vi.fn(),
  };
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex, instanceId: "instance-1" });
  const discovery = await server.start();
  let client: WebSocket | undefined;
  let upstream: WebSocket | undefined;
  try {
    expect(discovery.codexEndpoint).not.toBe(upstreamEndpoint);
    expect(discovery.codexEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/u);
    const upstreamConnected = new Promise<WebSocket>((resolve) => upstreamServer.once("connection", resolve));
    client = new WebSocket(discovery.codexEndpoint);
    await new Promise<void>((resolve, reject) => { client!.once("open", resolve); client!.once("error", reject); });
    upstream = await upstreamConnected;

    client.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "tui" } } }));
    expect(await nextJson(upstream)).toMatchObject({ id: 1, method: "initialize" });
    upstream.send(JSON.stringify({ id: 1, result: { codexHome: "tmp" } }));
    expect(await nextJson(client)).toEqual({ id: 1, result: { codexHome: "tmp" } });

    client.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: "C:/project" } }));
    expect(await nextJson(upstream)).toEqual({
      id: 2,
      method: "thread/start",
      params: { cwd: "C:/project", dynamicTools: [{ name: "lane_directory" }], developerInstructions: "router instructions" },
    });
    upstream.send(JSON.stringify({ id: 2, result: { thread: { id: "thread-new", status: { type: "idle" }, turns: [] } } }));
    await expect(nextJson(client)).resolves.toMatchObject({ id: 2, result: { thread: { id: "thread-new" } } });
    expect(claimed).toEqual(["thread-new"]);

    upstream.send(JSON.stringify({ id: 3, method: "item/tool/call", params: { threadId: "thread-new", turnId: "turn-1", callId: "call-1", tool: "lane_directory", arguments: { project: "alpha" } } }));
    await expect(nextJson(upstream)).resolves.toEqual({ id: 3, result: { success: true, contentItems: [{ type: "inputText", text: "ok" }] } });
    expect(codex.dispatchTool).toHaveBeenCalledOnce();

    upstream.send(JSON.stringify({ method: "thread/status/changed", params: { threadId: "thread-new", status: { type: "idle" } } }));
    await expect(nextJson(client)).resolves.toMatchObject({ method: "thread/status/changed" });
    expect(codex.observeNotification).toHaveBeenCalledWith("thread/status/changed", { threadId: "thread-new", status: { type: "idle" } });

    client.send(JSON.stringify({ id: 4, method: "thread/resume", params: { threadId: "foreign" } }));
    await expect(nextJson(client)).resolves.toMatchObject({ id: 4, error: { message: expect.stringMatching(/not owned/i) } });
  } finally {
    client?.close(); upstream?.close();
    await server.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

test("serves health and four lane calls on loopback", async () => {
  const tools = { call: vi.fn(async (name: string) => ({ name })) };
  const codex = {
    endpoint: "ws://127.0.0.1:45000",
  };
  const server = new LocalRouterServer({ tools: tools as never, codex: codex as never, instanceId: "instance-1" });
  const discovery = await server.start();
  try {
    expect(discovery.url).toMatch(/^http:\/\/127\.0\.0\.1:/u);
    const client = new LocalRouterClient(async () => discovery.url);
    await expect(probeRouterHealth(discovery.url)).resolves.toMatchObject({ instanceId: "instance-1", codexEndpoint: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/u) });
    await expect(client.call("lane_directory", { project: "alpha" }, {
      backend: "claude", conversationId: "session-1", requestKey: "request-1",
    })).resolves.toEqual({ name: "lane_directory" });
    // The fourth argument is the caller's lifetime: the Router stops working on a request once
    // the caller is gone, so a takeover can no longer complete after its attach was reported failed.
    expect(tools.call).toHaveBeenCalledWith("lane_directory", { project: "alpha" }, {
      backend: "claude", conversationId: "session-1", requestKey: "request-1",
    }, expect.any(AbortSignal));
  } finally { await server.close(); }
});

test("rejects non-loopback binding configuration and unknown RPC methods", async () => {
  expect(() => new LocalRouterServer({ tools: {} as never, codex: {} as never, instanceId: "x", host: "0.0.0.0" })).toThrow(/loopback/i);
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex: { endpoint: "ws://127.0.0.1:1" } as never, instanceId: "x" });
  const discovery = await server.start();
  try {
    const response = await fetch(`${discovery.url}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "unknown_tool", params: {}, context: {} }) });
    expect(response.status).toBe(400);
  } finally { await server.close(); }
});

test("bridges body-free Claude notifications and waits for lifecycle Stop before replacement", async () => {
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex: { endpoint: "ws://127.0.0.1:1" } as never, instanceId: "x" });
  const discovery = await server.start();
  const channel = await connectClaudeChannel(async () => discovery.url, "session-1");
  const notifications: unknown[] = [];
  channel.attach({ notification: async (value) => { notifications.push(value); } });
  const binding: BindingRecord = { id: "binding-1", laneAddress: "alpha/design", backend: "claude", conversationId: "session-1", generation: 1, startup: {}, activeAt: 1, inactiveAt: null, cwd: null };
  const notification = { laneAddress: "alpha/design", pendingPath: "C:/mailbox/pending", kind: "normal" as const, messageIds: ["message-1"] };
  try {
    // Claude Code queues a mid-turn notification itself, so a busy target is not a different
    // outcome here: both calls only establish that the frame left the Router.
    await expect(server.claude.notify(binding, notification)).resolves.toBe("sent");
    await expect(server.claude.notify(binding, notification)).resolves.toBe("sent");
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
  const binding: BindingRecord = { id: "binding-1", laneAddress: "alpha/design", backend: "claude", conversationId: "session-1", generation: 1, startup: {}, activeAt: 1, inactiveAt: null, cwd: null };
  const hub = new ClaudeChannelHub((conversationId) => conversationId === "session-1" ? binding : undefined);
  const attention: string[] = [];
  hub.onAttentionOpportunity((current) => { attention.push(current.laneAddress); });
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex: { endpoint: "ws://127.0.0.1:1" } as never, instanceId: "x", claude: hub });
  const discovery = await server.start();
  const channel = await connectClaudeChannel(async () => discovery.url, "session-1");
  try { await vi.waitFor(() => expect(attention).toEqual(["alpha/design"])); }
  finally { await channel.close(); await server.close(); }
});

test("a Claude channel follows the Router that replaced the one it was connected to", async () => {
  const binding: BindingRecord = { id: "binding-1", laneAddress: "alpha/design", backend: "claude", conversationId: "session-1", generation: 1, startup: {}, activeAt: 1, inactiveAt: null, cwd: null };
  const notification = { laneAddress: "alpha/design", pendingPath: "C:/mailbox/pending", kind: "normal" as const, messageIds: ["message-1"] };
  const startRouter = async () => {
    const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex: { endpoint: "ws://127.0.0.1:1" } as never, instanceId: "x" });
    return { server, discovery: await server.start() };
  };

  const original = await startRouter();
  const replacement = await startRouter();
  let routerUrl = original.discovery.url;
  const channel = await connectClaudeChannel(async () => routerUrl, "session-1");
  const notifications: unknown[] = [];
  channel.attach({ notification: async (value) => { notifications.push(value); } });
  try {
    await original.server.claude.notify(binding, notification);
    await vi.waitFor(() => expect(notifications).toHaveLength(1));

    // A Router dies with the session that started it, so a session that stays open has to follow
    // the replacement instead of holding a socket that will never carry another notification.
    await original.server.close();
    routerUrl = replacement.discovery.url;

    await vi.waitFor(async () => {
      await replacement.server.claude.notify(binding, notification);
      expect(notifications.length).toBeGreaterThan(1);
    }, { timeout: 5_000, interval: 50 });
  } finally { await channel.close(); await replacement.server.close(); }
}, 15_000);

const CALLER = { backend: "claude" as const, conversationId: "session-1", requestKey: "request-1" };

async function startNamedRouter(instanceId: string) {
  const server = new LocalRouterServer({
    tools: { call: vi.fn(async (name: string) => ({ name, instanceId })) } as never,
    codex: { endpoint: "ws://127.0.0.1:1" } as never,
    instanceId,
  });
  return { server, discovery: await server.start() };
}

test("a Router client follows the Router that replaced the one it was pinned to", async () => {
  const original = await startNamedRouter("instance-1");
  const replacement = await startNamedRouter("instance-2");
  let routerUrl = original.discovery.url;
  const client = new LocalRouterClient(async () => routerUrl);
  try {
    await expect(client.call("lane_directory", { project: "alpha" }, CALLER))
      .resolves.toEqual({ name: "lane_directory", instanceId: "instance-1" });

    // The pinned URL stops answering the way a replaced Router does: nothing listens on it any
    // more, so the connection is refused before a single request byte is delivered.
    await original.server.close();
    routerUrl = replacement.discovery.url;

    await expect(client.call("lane_directory", { project: "alpha" }, CALLER))
      .resolves.toEqual({ name: "lane_directory", instanceId: "instance-2" });
  } finally { await replacement.server.close(); }
});

test("the connection-refused signature the rebind depends on", async () => {
  // The retry rule rests on this exact value coming out of Node's fetch, which is a detail of the
  // runtime rather than a documented contract. A Node upgrade that changes it must fail here
  // loudly instead of leaving the rebind silently dead.
  const router = await startNamedRouter("instance-1");
  let closed = false;
  try {
    // Control: a listening port must succeed, or a probe broken for its own reasons would score
    // full marks on the assertion below.
    await expect(fetch(`${router.discovery.url}/health`)).resolves.toMatchObject({ ok: true });
    await router.server.close();
    closed = true;
    await expect(fetch(`${router.discovery.url}/rpc`, { method: "POST", body: "{}" }))
      .rejects.toMatchObject({ cause: { code: "ECONNREFUSED" } });
  } finally { if (!closed) await router.server.close(); }
});

test("a Router client retries only a failure that proves the request never reached a Router", async () => {
  const attempts: string[] = [];
  const rejectWith = (cause: unknown) => vi.stubGlobal("fetch", async (input: unknown) => {
    attempts.push(String(input));
    throw Object.assign(new TypeError("fetch failed"), { cause });
  });
  let resolutions = 0;
  const client = new LocalRouterClient(async () => `http://127.0.0.1:${9000 + resolutions++}`);
  try {
    // Connected and then something went wrong: the Router may already have acted on the request,
    // and `lane_ack` is not idempotent — resolving an already-resolved message throws — so this
    // must reach the caller as a failure rather than be tried again.
    rejectWith({ code: "ECONNRESET" });
    await expect(client.call("lane_ack", { message_ids: ["message-1"] }, CALLER)).rejects.toThrow(/fetch failed/u);
    expect(attempts).toHaveLength(1);

    attempts.length = 0;
    rejectWith(undefined);
    await expect(client.call("lane_ack", { message_ids: ["message-1"] }, CALLER)).rejects.toThrow(/fetch failed/u);
    expect(attempts).toHaveLength(1);

    attempts.length = 0;
    vi.stubGlobal("fetch", async (input: unknown) => {
      attempts.push(String(input));
      return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
    });
    await expect(client.call("lane_ack", { message_ids: ["message-1"] }, CALLER)).rejects.toThrow(/boom/u);
    expect(attempts).toHaveLength(1);
  } finally { vi.unstubAllGlobals(); }
});

test("a Router client does not re-resolve while its Router keeps answering", async () => {
  const router = await startNamedRouter("instance-1");
  let resolutions = 0;
  const client = new LocalRouterClient(async () => { resolutions += 1; return router.discovery.url; });
  try {
    for (let call = 0; call < 3; call += 1) {
      await expect(client.call("lane_directory", { project: "alpha" }, CALLER)).resolves.toMatchObject({ name: "lane_directory" });
    }
    expect(resolutions).toBe(1);
  } finally { await router.server.close(); }
});

test("a Router client gives up when re-resolution names the same dead address", async () => {
  const attempts: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    attempts.push(String(input));
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  });
  let resolutions = 0;
  const client = new LocalRouterClient(async () => { resolutions += 1; return "http://127.0.0.1:9001"; });
  try {
    await expect(client.call("lane_directory", { project: "alpha" }, CALLER)).rejects.toThrow(/fetch failed/u);
    // Re-resolved once and found the same address, which means discovery still believes that
    // Router is alive; trying it again would fail identically and hide the real problem.
    expect(resolutions).toBe(2);
    expect(attempts).toHaveLength(1);
  } finally { vi.unstubAllGlobals(); }
});

function nextJson(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => {
      try { resolve(JSON.parse(raw.toString()) as unknown); }
      catch (error) { reject(error); }
    });
    socket.once("error", reject);
  });
}

test("hands a lifecycle-reported cwd to the recorder even when no channel is connected", async () => {
  const recordCwd = vi.fn();
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex: { endpoint: "ws://127.0.0.1:1" } as never, instanceId: "x", recordCwd });
  const discovery = await server.start();
  try {
    // No channel exists for this conversation, so the hub cannot accept the event — but the cwd
    // is a fact about the conversation, not about the channel, and must be recorded anyway.
    const response = await fetch(`${discovery.url}/claude/lifecycle`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "session-9", event: "Stop", cwd: "E:\\project" }),
    });
    expect(response.status).toBe(400);
    expect(recordCwd).toHaveBeenCalledExactlyOnceWith("session-9", "E:\\project");

    const withoutCwd = await fetch(`${discovery.url}/claude/lifecycle`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "session-9", event: "Stop" }),
    });
    expect(withoutCwd.status).toBe(400);
    expect(recordCwd).toHaveBeenCalledTimes(1);
  } finally { await server.close(); }
});

test("serves resume info for the lane launcher on loopback", async () => {
  const info = { state: "bound", backend: "claude", conversationId: "session-1", cwd: "E:\\project", generation: 2, reach: null };
  const resumeInfo = vi.fn(() => info);
  const server = new LocalRouterServer({ tools: { call: vi.fn() } as never, codex: { endpoint: "ws://127.0.0.1:1" } as never, instanceId: "x", resumeInfo });
  const discovery = await server.start();
  try {
    const response = await fetch(`${discovery.url}/lanes/resume-info?address=${encodeURIComponent("alpha/design")}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: info });
    expect(resumeInfo).toHaveBeenCalledExactlyOnceWith("alpha/design");

    const missingAddress = await fetch(`${discovery.url}/lanes/resume-info`);
    expect(missingAddress.status).toBe(400);

    resumeInfo.mockImplementation(() => { throw new Error("Invalid lane address"); });
    const invalid = await fetch(`${discovery.url}/lanes/resume-info?address=bad`);
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "Invalid lane address" });
  } finally { await server.close(); }
});
