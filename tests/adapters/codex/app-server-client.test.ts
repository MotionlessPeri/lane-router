import { afterEach, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { AppServerClient, AppServerDisconnectedError, AppServerRequestTimeoutError } from "../../../src/adapters/codex/app-server-client.js";
import { decodeServerMessage, decodeThreadReadResult, decodeTurnStartResult, ProtocolDecodeError } from "../../../src/adapters/codex/protocol.js";
import { CodexAppServerProcess, CodexCapabilityError, CodexCapabilityGate } from "../../../src/adapters/codex/app-server-process.js";

const servers: WebSocketServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("protocol decoder accepts consumed messages and unknown fields", () => {
  expect(decodeServerMessage({ id: 1, result: { ok: true }, future: 1 })).toMatchObject({ kind: "response", id: 1 });
  expect(decodeServerMessage({ method: "turn/started", params: { threadId: "th", turn: { id: "tu", status: "inProgress", items: [] } } })).toMatchObject({ kind: "notification", method: "turn/started" });
  expect(decodeServerMessage({ id: "r", method: "item/tool/call", params: { threadId: "th", turnId: "tu", callId: "ca", tool: "lane_status", arguments: {} } })).toMatchObject({ kind: "request", method: "item/tool/call" });
});

test.each([
  {},
  { id: 1, result: 3, error: { code: 1, message: "both" } },
  { method: "turn/started", params: { threadId: 2 } },
  { id: 1, method: "item/tool/call", params: { threadId: "th", turnId: "tu", tool: "x", arguments: {} } },
])("protocol decoder rejects malformed required fields: %j", (message) => {
  expect(() => decodeServerMessage(message)).toThrow(ProtocolDecodeError);
});

test("consumed response decoders validate nested thread and turn discriminators", () => {
  expect(decodeThreadReadResult({ thread: { id: "th", status: { type: "active" }, turns: [{ id: "tu", status: "inProgress", items: [] }] } })).toMatchObject({ thread: { id: "th", status: { type: "active" } } });
  expect(decodeTurnStartResult({ turn: { id: "tu", status: "inProgress", items: [] } })).toMatchObject({ turn: { id: "tu", status: "inProgress" } });
  expect(() => decodeThreadReadResult({ thread: { id: "th", status: { renamed: "idle" }, turns: [] } })).toThrow(ProtocolDecodeError);
  expect(() => decodeThreadReadResult({ thread: { id: "th", status: { type: "idle" }, turns: [{ id: "tu", status: "renamed", items: [] }] } })).toThrow(ProtocolDecodeError);
  expect(() => decodeTurnStartResult({ turn: { id: 4, status: "inProgress", items: [] } })).toThrow(ProtocolDecodeError);
});

async function server(handler: (message: Record<string, unknown>, socket: import("ws").WebSocket) => void): Promise<string> {
  const instance = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(instance);
  await new Promise<void>((resolve) => instance.once("listening", resolve));
  instance.on("connection", (socket) => socket.on("message", (data) => handler(JSON.parse(data.toString()) as Record<string, unknown>, socket)));
  const address = instance.address();
  if (typeof address === "string" || address === null) throw new Error("missing port");
  return `ws://127.0.0.1:${address.port}`;
}

test("client initializes, correlates responses, emits notifications, and answers server requests", async () => {
  const seen: string[] = [];
  const url = await server((message, socket) => {
    seen.push(String(message.method));
    if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fake", platformFamily: "windows", platformOs: "windows", codexHome: "tmp" } }));
    if (message.method === "echo") {
      socket.send(JSON.stringify({ method: "thread/status/changed", params: { threadId: "th", status: { type: "idle" } } }));
      socket.send(JSON.stringify({ id: "tool-1", method: "item/tool/call", params: { threadId: "th", turnId: "tu", callId: "ca", tool: "lane_status", arguments: {} } }));
      socket.send(JSON.stringify({ id: message.id, result: message.params }));
    }
  });
  const notifications: string[] = [];
  const client = new AppServerClient({ url, requestTimeoutMs: 1_000 });
  client.onNotification((message) => notifications.push(message.method));
  client.onServerRequest(async () => ({ success: true, contentItems: [{ type: "inputText", text: "ok" }] }));
  await client.connect();
  expect(await client.request("echo", { value: 3 })).toEqual({ value: 3 });
  await vi.waitFor(() => expect(seen).toContain("undefined"));
  expect(seen.slice(0, 2)).toEqual(["initialize", "initialized"]);
  expect(notifications).toEqual(["thread/status/changed"]);
  await client.close();
});

test("timeouts, disconnects, and shutdown reject pending requests", async () => {
  let socket: import("ws").WebSocket | undefined;
  const url = await server((message, current) => {
    socket = current;
    if (message.method === "initialize") current.send(JSON.stringify({ id: message.id, result: { userAgent: "fake", platformFamily: "windows", platformOs: "windows", codexHome: "tmp" } }));
  });
  const client = new AppServerClient({ url, requestTimeoutMs: 20 });
  await client.connect();
  await expect(client.request("never", {})).rejects.toBeInstanceOf(AppServerRequestTimeoutError);
  const pending = client.request("pending", {});
  socket?.close();
  await expect(pending).rejects.toBeInstanceOf(AppServerDisconnectedError);
  await client.close();
});

test("a malformed correlated response rejects immediately with a typed protocol error", async () => {
  const url = await server((message, socket) => {
    if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fake", platformFamily: "windows", platformOs: "windows", codexHome: "tmp" } }));
    if (message.method === "broken") socket.send(JSON.stringify({ id: message.id, result: {}, error: { code: 1, message: "both" } }));
  });
  const client = new AppServerClient({ url, requestTimeoutMs: 1_000 });
  const errors: Error[] = [];
  client.onProtocolError((error) => errors.push(error));
  await client.connect();
  await expect(client.request("broken", {})).rejects.toBeInstanceOf(ProtocolDecodeError);
  expect(errors).toHaveLength(1);
  await client.close();
});

test("an uncorrelated malformed message fences the connection and rejects pending", async () => {
  const url = await server((message, socket) => {
    if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fake", platformFamily: "windows", platformOs: "windows", codexHome: "tmp" } }));
    if (message.method === "pending") socket.send(JSON.stringify({ method: "turn/started", params: { threadId: 2 } }));
  });
  const client = new AppServerClient({ url, requestTimeoutMs: 1_000 });
  await client.connect();
  await expect(client.request("pending", {})).rejects.toBeInstanceOf(ProtocolDecodeError);
  expect(client.isConnected()).toBe(false);
});

test("reconnect attempts are bounded", async () => {
  const client = new AppServerClient({ url: "ws://127.0.0.1:1", requestTimeoutMs: 20 });
  await expect(client.reconnect({ attempts: 2, backoffMs: 1 })).rejects.toBeInstanceOf(AppServerDisconnectedError);
  expect(client.isConnected()).toBe(false);
});

function fakeCommand(env: Record<string, string> = {}) {
  return { executable: process.execPath, prefixArgs: [join(process.cwd(), "tests", "fixtures", "codex", "fake-app-server.mjs")], env };
}

test("capability gate validates a compatible executable/schema and caches only its fingerprint", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "lane-router-capability-cache-")); dirs.push(cacheDir);
  const gate = new CodexCapabilityGate({ cacheDir });
  const first = await gate.verify(fakeCommand());
  const second = await gate.verify(fakeCommand());
  expect(first).toMatchObject({ version: "codex-cli 0.146.1-fake" });
  expect(second.fingerprint).toBe(first.fingerprint);
  expect(second.cached).toBe(true);
});

test("semantic schema formatting changes preserve the fingerprint and cache hit", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "lane-router-capability-semantic-")); dirs.push(cacheDir);
  const gate = new CodexCapabilityGate({ cacheDir });
  const compact = await gate.verify(fakeCommand({ FAKE_CODEX_FORMAT: "compact" }));
  const pretty = await gate.verify(fakeCommand({ FAKE_CODEX_FORMAT: "pretty" }));
  expect(pretty.fingerprint).toBe(compact.fingerprint);
  expect(pretty.cached).toBe(true);
});

test("decoy method strings with incompatible structural shapes fail the gate", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "lane-router-capability-decoy-")); dirs.push(cacheDir);
  const gate = new CodexCapabilityGate({ cacheDir });
  await expect(gate.verify(fakeCommand({ FAKE_CODEX_SCHEMA: "decoy" }))).rejects.toBeInstanceOf(CodexCapabilityError);
});

test("incompatible schema produces a typed failure before managed spawn", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "lane-router-capability-bad-")); dirs.push(cacheDir);
  const gate = new CodexCapabilityGate({ cacheDir });
  await expect(gate.verify(fakeCommand({ FAKE_CODEX_SCHEMA: "incompatible" }))).rejects.toBeInstanceOf(CodexCapabilityError);
  let spawned = 0;
  const manager = new CodexAppServerProcess({ command: fakeCommand({ FAKE_CODEX_SCHEMA: "incompatible" }), gate, spawnProcess: () => { spawned += 1; throw new Error("must not spawn"); } });
  await expect(manager.start()).rejects.toBeInstanceOf(CodexCapabilityError);
  expect(spawned).toBe(0);
});

test("capability gate rejects thread/start without dynamicTools", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "lane-router-capability-dynamic-")); dirs.push(cacheDir);
  const gate = new CodexCapabilityGate({ cacheDir });
  await expect(gate.verify(fakeCommand({ FAKE_CODEX_SCHEMA: "missing-dynamic-tools" }))).rejects.toBeInstanceOf(CodexCapabilityError);
});

test.each(["bad-thread-status", "bad-turn-items", "bad-dynamic-output"])("capability gate rejects structurally invalid consumed response shape: %s", async (schemaMode) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "lane-router-capability-response-")); dirs.push(cacheDir);
  const gate = new CodexCapabilityGate({ cacheDir });
  await expect(gate.verify(fakeCommand({ FAKE_CODEX_SCHEMA: schemaMode }))).rejects.toBeInstanceOf(CodexCapabilityError);
});

test("process manager selects loopback, waits for readiness, and shuts down cleanly", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "lane-router-process-")); dirs.push(cacheDir);
  const manager = new CodexAppServerProcess({ command: fakeCommand(), gate: new CodexCapabilityGate({ cacheDir }), readinessTimeoutMs: 3_000 });
  const endpoint = await manager.start();
  expect(endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
  expect(manager.client.isConnected()).toBe(true);
  await manager.shutdown();
  expect(manager.client.isConnected()).toBe(false);
});

test("process manager coalesces sequential starts and can start again after shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-router-process-idempotent-")); dirs.push(root);
  const children: ReturnType<typeof spawn>[] = [];
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  }) as typeof spawn;
  const manager = new CodexAppServerProcess({ command: fakeCommand(), gate: new CodexCapabilityGate({ cacheDir: join(root, "cache") }), readinessTimeoutMs: 3_000, spawnProcess });
  try {
    const first = await manager.start();
    const second = await manager.start();
    expect(second).toBe(first);
    expect(children).toHaveLength(1);
    await manager.shutdown();
    const restarted = await manager.start();
    expect(restarted).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(children).toHaveLength(2);
  } finally {
    await manager.shutdown();
    for (const child of children) if (child.exitCode === null) child.kill();
  }
  expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
});

test("process manager coalesces concurrent starts without leaking children", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-router-process-concurrent-")); dirs.push(root);
  const children: ReturnType<typeof spawn>[] = [];
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  }) as typeof spawn;
  const manager = new CodexAppServerProcess({ command: fakeCommand(), gate: new CodexCapabilityGate({ cacheDir: join(root, "cache") }), readinessTimeoutMs: 3_000, spawnProcess });
  try {
    const endpoints = await Promise.all([manager.start(), manager.start(), manager.start()]);
    expect(new Set(endpoints).size).toBe(1);
    expect(children).toHaveLength(1);
  } finally {
    await manager.shutdown();
    for (const child of children) if (child.exitCode === null) child.kill();
  }
  expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
});

test("process manager restarts an unexpected exit with bounded backoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-router-process-restart-")); dirs.push(root);
  const marker = join(root, "exited-once");
  let reconnected = 0;
  const manager = new CodexAppServerProcess({ command: fakeCommand({ FAKE_CODEX_EXIT_ONCE_FILE: marker }), gate: new CodexCapabilityGate({ cacheDir: join(root, "cache") }), readinessTimeoutMs: 3_000, restartBackoffMs: 5, onReconnect: () => { reconnected += 1; } });
  await manager.start();
  const originalClient = manager.client;
  await vi.waitFor(() => expect(reconnected).toBe(1), { timeout: 5_000 });
  expect(manager.client).toBe(originalClient);
  expect(manager.client.isConnected()).toBe(true);
  await manager.shutdown();
});

test("shutdown during restart backoff cannot spawn an orphan", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-router-process-race-")); dirs.push(root);
  const marker = join(root, "exited-once");
  let spawned = 0;
  const children: ReturnType<typeof spawn>[] = [];
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    spawned += 1;
    const child = spawn(...args);
    children.push(child);
    return child;
  }) as typeof spawn;
  const manager = new CodexAppServerProcess({ command: fakeCommand({ FAKE_CODEX_EXIT_ONCE_FILE: marker }), gate: new CodexCapabilityGate({ cacheDir: join(root, "cache") }), readinessTimeoutMs: 3_000, restartBackoffMs: 250, spawnProcess });
  try {
    await manager.start();
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    await vi.waitFor(() => expect(manager.client.isConnected()).toBe(false));
    await manager.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(spawned).toBe(1);
    expect(manager.client.isConnected()).toBe(false);
    expect(children.every((child) => child.exitCode !== null)).toBe(true);
  } finally {
    await manager.shutdown();
    for (const child of children) if (child.exitCode === null) child.kill();
  }
});
