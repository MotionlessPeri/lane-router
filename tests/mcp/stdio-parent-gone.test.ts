import { PassThrough } from "node:stream";

import { afterEach, expect, test, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { runLaneMcpStdio } from "../../src/mcp/lane-mcp-server.js";

// Spec docs/superpowers/specs/2026-10-21-task-lane.md, 4.3 item 4 and acceptance 5c: a lane MCP
// server whose parent is gone closes its channel and exits. The SDK's stdio transport does not
// listen for the end of stdin, so without this an orphan would keep a lane looking online.

const fixture = vi.hoisted(() => ({ transport: undefined as any, channelClose: undefined as any }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class { constructor() { return fixture.transport; } } }));
vi.mock("../../src/process/ensure-router.js", () => ({ ensureRouter: async () => ({ url: "http://fixture.invalid" }) }));
vi.mock("../../src/process/local-client.js", () => ({
  LocalRouterClient: class { async call() { return {}; } },
  connectClaudeChannel: async () => ({ attach() {}, detach() {}, close: fixture.channelClose }),
}));

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function start() {
  const [, server] = InMemoryTransport.createLinkedPair(); fixture.transport = server;
  fixture.channelClose = vi.fn(async () => undefined);
  const stdin = new PassThrough();
  const exit = vi.fn();
  const runtime = await runLaneMcpStdio({ stdin, exit, conversationId: () => "session-1", joinKey: () => "4242" });
  closers.push(() => runtime.close());
  return { stdin, exit, runtime, channelClose: fixture.channelClose };
}

test.each(["end", "close"] as const)("acceptance 5c: stdin's %s closes the channel and exits 0", async (event) => {
  const x = await start();
  x.stdin.emit(event);
  await vi.waitFor(() => expect(x.exit).toHaveBeenCalledExactlyOnceWith(0));
  expect(x.channelClose).toHaveBeenCalled();
});

test("both events, as a real pipe sends them, still exit once", async () => {
  const x = await start();
  x.stdin.emit("end");
  x.stdin.emit("close");
  await vi.waitFor(() => expect(x.exit).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(x.exit).toHaveBeenCalledTimes(1);
});

test("closing the runtime by itself does not end the process", async () => {
  const x = await start();
  await x.runtime.close();
  expect(x.channelClose).toHaveBeenCalled();
  expect(x.exit).not.toHaveBeenCalled();
});
