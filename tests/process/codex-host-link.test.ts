import type { AddressInfo } from "node:net";

import { afterEach, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";

import { CODEX_HOST_PROTOCOL_VERSION, PROTOCOL_MISMATCH_CLOSE, type HostHello } from "../../src/adapters/codex/host-protocol.js";
import { CodexHostLink } from "../../src/process/codex-host-link.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const hello: HostHello = { protocolVersion: CODEX_HOST_PROTOCOL_VERSION, instanceId: "h", pid: 1, build: "b", appServer: "ready", threads: [] };
const context = { backend: "codex", conversationId: "t", requestKey: "k" } as const;

function link(resolveCore: () => Promise<string | undefined>) {
  const value = new CodexHostLink({ resolveCore, hello: () => hello, appServerRequest: async () => ({}), reconnectDelaysMs: [20] });
  cleanups.push(() => value.close());
  return value;
}

test("with no core to reach, a lane tool fails at once and says the Router is not running", async () => {
  const value = link(async () => undefined);
  value.start();
  const startedAt = Date.now();
  const error = await value.callTool("lane_directory", { project: "alpha" }, context).catch((reason: unknown) => reason) as Error & { code?: string };
  expect(Date.now() - startedAt).toBeLessThan(100);
  expect(error.code).toBe("ROUTER_UNAVAILABLE");
  expect(error.message).toMatch(/not running .* not executed/u);
  await expect(value.ownsThread("t")).rejects.toMatchObject({ code: "ROUTER_UNAVAILABLE" });
});

test("a core that refuses this host's protocol is named in the error, with the way out", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  let hellos = 0;
  server.on("connection", (socket) => socket.once("message", () => { hellos += 1; socket.close(PROTOCOL_MISMATCH_CLOSE, "this Router speaks Codex host protocol 2, the host speaks 1"); }));
  const value = link(async () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  value.start();
  await vi.waitFor(() => expect(hellos).toBeGreaterThanOrEqual(1));
  await vi.waitFor(async () => {
    const error = await value.callTool("lane_directory", {}, context).catch((reason: unknown) => reason) as Error;
    expect(error.message).toMatch(/refused this Codex host .*protocol 2.*-CodexHost/u);
  });
});

// A refusal does not lift on its own: it lasts until someone replaces the host. Knocking at the
// ordinary reconnect pace would write a line to both logs every few seconds for as long as that takes.
test("a refused host waits much longer before asking again and logs the refusal once", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  let hellos = 0;
  server.on("connection", (socket) => socket.once("message", () => { hellos += 1; socket.close(PROTOCOL_MISMATCH_CLOSE, "protocol 2 vs 1"); }));
  const logs: string[] = [];
  const value = new CodexHostLink({
    resolveCore: async () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hello: () => hello, appServerRequest: async () => ({}), reconnectDelaysMs: [10], refusedDelayMs: 250, log: (line) => logs.push(line),
  });
  cleanups.push(() => value.close());
  value.start();
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(hellos).toBeGreaterThanOrEqual(2);
  expect(hellos).toBeLessThanOrEqual(4);
  expect(logs).toHaveLength(1);
});

test("the host introduces itself first and then answers the core's App Server requests", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const received: Array<Record<string, unknown>> = [];
  server.on("connection", (socket) => {
    socket.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    socket.send(JSON.stringify({ id: 7, method: "appServer.request", params: { method: "thread/read", params: { threadId: "t" } } }));
  });
  const appServerRequest = vi.fn(async (method: string) => ({ answered: method }));
  const value = new CodexHostLink({ resolveCore: async () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hello: () => hello, appServerRequest });
  cleanups.push(() => value.close());
  value.start();
  await vi.waitFor(() => expect(received).toHaveLength(2));
  expect(received[0]).toEqual({ method: "hello", params: hello });
  expect(received[1]).toEqual({ id: 7, result: { answered: "thread/read" } });
  expect(appServerRequest).toHaveBeenCalledWith("thread/read", { threadId: "t" });
});
