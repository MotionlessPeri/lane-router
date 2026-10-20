import type { AddressInfo } from "node:net";

import { afterEach, expect, test, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { AccountError } from "../../src/accounts/contracts.js";
import { CODEX_HOST_PROTOCOL_VERSION, LinkPeer, PROTOCOL_MISMATCH_CLOSE } from "../../src/adapters/codex/host-protocol.js";
import { CodexBackend } from "../../src/backends/codex-backend.js";
import { CodexHostHub } from "../../src/process/codex-host-hub.js";
import type { BindingRecord } from "../../src/router/types.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const binding = (conversationId: string, cwd?: string): BindingRecord => ({
  id: `binding-${conversationId}`, laneAddress: `alpha/${conversationId}`, backend: "codex", conversationId,
  generation: 1, startup: cwd === undefined ? {} : { cwd }, activeAt: 1, inactiveAt: null, cwd: null,
});

async function harness(bindings: BindingRecord[] = []) {
  const opportunities: string[][] = [];
  const logs: string[] = [];
  const callTool = vi.fn(async (name: string) => ({ called: name }));
  const hub = new CodexHostHub({
    state: {
      activeBindingForConversation: (_backend, id) => bindings.find((entry) => entry.conversationId === id),
      latestBindingForConversation: (_backend, id) => bindings.find((entry) => entry.conversationId === id),
      activeBindings: () => bindings,
    },
    callTool, build: "core-build", opportunity: (ids) => { opportunities.push([...ids]); }, log: (line) => logs.push(line),
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => hub.connect(socket));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  cleanups.push(() => hub.close());
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** A host as the core sees it: a socket, a hello, and answers to App Server requests. */
  const host = async (options: { version?: number; build?: string; threads?: Array<{ threadId: string; visibleClients: number }>; appServer?: (method: string, params: unknown) => Promise<unknown> } = {}) => {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    cleanups.push(() => socket.terminate());
    const peer = new LinkPeer(socket, {
      request: async (method, params) => {
        if (method !== "appServer.request") throw new Error("unexpected");
        return (options.appServer ?? (async () => ({})))(params.method as string, params.params);
      },
      event: () => undefined,
    }, { lostError: () => new Error("lost") });
    peer.event("hello", {
      protocolVersion: options.version ?? CODEX_HOST_PROTOCOL_VERSION, instanceId: "host", pid: 1, build: options.build ?? "host-build",
      appServer: "ready", threads: options.threads ?? [],
    });
    return { socket, peer };
  };
  return { hub, host, opportunities, logs, callTool, url };
}

test("a host speaking another protocol version is refused with 4001 and a reason", async () => {
  const x = await harness();
  const { socket } = await x.host({ version: 99 });
  const closed = await new Promise<{ code: number; reason: string }>((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  expect(closed.code).toBe(PROTOCOL_MISMATCH_CLOSE);
  expect(closed.reason).toMatch(/protocol 1.*99/u);
  expect(x.hub.status().connected).toBe(false);
  expect(x.logs.join("\n")).toMatch(/refused/u);
});

test("an account switch in progress on the host defers a notification instead of failing it", async () => {
  const x = await harness();
  await x.host({ appServer: async (method) => {
    if (method === "thread/read") return { thread: { id: "t-1", status: { type: "idle" }, turns: [] } };
    throw new AccountError("ACCOUNT_SWITCH_IN_PROGRESS");
  } });
  await vi.waitFor(() => expect(x.hub.client.isConnected()).toBe(true));
  const backend = new CodexBackend({ client: x.hub.client, resolveLane: () => "alpha/t-1" });
  await expect(backend.notifyNormal(binding("t-1"), { laneAddress: "alpha/t-1", pendingPath: "p", kind: "normal", messageIds: ["m"], messages: [] }))
    .resolves.toBe("deferred");
});

test("tool calls run as codex, fall back to the binding's startup cwd, and end when the host goes", async () => {
  const x = await harness([binding("t-1", "C:/bound")]);
  let signal: AbortSignal | undefined;
  x.callTool.mockImplementationOnce(async (_name, _args, _context, received: AbortSignal) => { signal = received; return new Promise(() => undefined); });
  const { peer, socket } = await x.host();
  await vi.waitFor(() => expect(x.hub.status().connected).toBe(true));
  void peer.request("tool", { name: "lane_attach_current", arguments: { address: "alpha/x" }, context: { conversationId: "t-1", requestKey: "k", backend: "claude" } }).catch(() => undefined);
  await vi.waitFor(() => expect(x.callTool).toHaveBeenCalled());
  expect(x.callTool.mock.calls[0]![2]).toEqual({ backend: "codex", conversationId: "t-1", requestKey: "k", cwd: "C:/bound" });
  socket.terminate();
  await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  await expect(peer.request("ownsThread", { threadId: "t-1" })).rejects.toThrow();
});

test("thread ownership is answered from the bindings the core holds", async () => {
  const x = await harness([binding("bound")]);
  const { peer } = await x.host();
  await vi.waitFor(() => expect(x.hub.status().connected).toBe(true));
  await expect(peer.request("ownsThread", { threadId: "bound" })).resolves.toBe(true);
  await expect(peer.request("ownsThread", { threadId: "stranger" })).resolves.toBe(false);
});

test("hello offers every thread the host has and every active codex binding a chance", async () => {
  const x = await harness([binding("bound-only")]);
  await x.host({ threads: [{ threadId: "open", visibleClients: 1 }] });
  await vi.waitFor(() => expect(x.opportunities).toEqual([["open", "bound-only"]]));
  expect(x.hub.hasVisibleClient("open")).toBe(true);
  expect(x.hub.hasVisibleClient("bound-only")).toBe(false);
});

// Opening a thread in a TUI loads it, and only a loaded thread can take a turn. Nothing says the
// App Server reports that thread going idle as it loads it, so the hub offers it itself: that
// thread alone, and only when its first window opens.
test("a thread's first visible client offers that thread alone, on the step up from none", async () => {
  const x = await harness([binding("bound-a"), binding("bound-b")]);
  const { peer } = await x.host();
  await vi.waitFor(() => expect(x.opportunities).toEqual([["bound-a", "bound-b"]]));
  x.opportunities.length = 0;
  peer.event("threadClients", { threadId: "bound-a", visibleClients: 1 });
  await vi.waitFor(() => expect(x.opportunities).toEqual([["bound-a"]]));
  for (const visibleClients of [2, 1, 0, 1]) peer.event("threadClients", { threadId: "bound-a", visibleClients });
  await vi.waitFor(() => expect(x.opportunities).toEqual([["bound-a"], ["bound-a"]]));
  expect(x.hub.hasVisibleClient("bound-a")).toBe(true);
});

// Replacement happens on an accepted hello, not on a bare connection: anything else on loopback
// could otherwise knock the working host off and fail its tool calls in flight.
test("a connection that never says hello does not displace the linked host", async () => {
  const x = await harness();
  const linked = await x.host({ build: "working" });
  await vi.waitFor(() => expect(x.hub.status().connected).toBe(true));
  const silent = new WebSocket(x.url);
  await new Promise<void>((resolve, reject) => { silent.once("open", resolve); silent.once("error", reject); });
  cleanups.push(() => silent.terminate());
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(linked.socket.readyState).toBe(WebSocket.OPEN);
  expect(x.hub.status()).toMatchObject({ connected: true, hostBuild: "working" });
});

test("an App Server recovering on the host reads as unavailable, and its return as ready again", async () => {
  const x = await harness([binding("t-1")]);
  const ready = vi.fn();
  x.hub.onReady(ready);
  const { peer } = await x.host();
  const backend = new CodexBackend({ client: x.hub.client, resolveLane: () => "alpha/t-1", hasVisibleClient: (id) => x.hub.hasVisibleClient(id) });
  await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  expect(backend.restorePresence(binding("t-1"))).toBe("offline");
  peer.event("appServer", { state: "recovering" });
  await vi.waitFor(() => expect(backend.restorePresence(binding("t-1"))).toBe("unavailable"));
  expect(backend.reach(binding("t-1")).state).toBe("no_channel");
  peer.event("appServer", { state: "ready" });
  await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2));
  expect(backend.restorePresence(binding("t-1"))).toBe("offline");
});

test("a newer host link replaces the older one", async () => {
  const x = await harness();
  const first = await x.host({ build: "old" });
  await vi.waitFor(() => expect(x.hub.status()).toEqual({ connected: true, hostBuild: "old", coreBuild: "core-build" }));
  const firstClosed = new Promise<void>((resolve) => first.socket.once("close", () => resolve()));
  await x.host({ build: "new" });
  await firstClosed;
  await vi.waitFor(() => expect(x.hub.status()).toEqual({ connected: true, hostBuild: "new", coreBuild: "core-build" }));
});
