import { expect, test, vi } from "vitest";

import { AccountError } from "../../../src/accounts/contracts.js";
import { CodexRuntime, type CodexCoreLink, type CodexProcessControl } from "../../../src/adapters/codex/codex-runtime.js";
import { CODEX_HOST_PROTOCOL_VERSION } from "../../../src/adapters/codex/host-protocol.js";
import { productToolCatalog } from "../../../src/application/builtin-tools.js";

/** A process whose client records what the runtime subscribes, so tests can play the App Server. */
function fakeProcess(state: CodexProcessControl["state"] = "ready") {
  let notify: ((message: { method: string; params: Record<string, unknown> }) => void) | undefined;
  let serverRequest: ((message: { method: string; params: unknown }) => Promise<unknown>) | undefined;
  let transportLoss: (() => void) | undefined;
  let reconnect: ((event?: { strategy?: string }) => void) | undefined;
  const request = vi.fn(async (method: string) => ({ answeredBy: "app-server", method }));
  const process = {
    state,
    client: {
      request,
      onNotification: (handler: typeof notify) => { notify = handler; return () => { notify = undefined; }; },
      onServerRequest: (handler: typeof serverRequest) => { serverRequest = handler; return () => { serverRequest = undefined; }; },
      onTransportLoss: (handler: typeof transportLoss) => { transportLoss = handler; return () => { transportLoss = undefined; }; },
    },
    start: vi.fn(async () => "ws://127.0.0.1:1"),
    shutdown: vi.fn(async () => undefined),
    onReconnect: (handler: typeof reconnect) => { reconnect = handler; return () => { reconnect = undefined; }; },
  } as unknown as CodexProcessControl;
  return {
    process, request,
    notify: (method: string, params: Record<string, unknown>) => notify?.({ method, params }),
    serverRequest: (method: string, params: unknown) => serverRequest!({ method, params }),
    transportLoss: () => transportLoss?.(),
    reconnect: (strategy: string) => reconnect?.({ strategy }),
  };
}

function fakeCore() {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const core = {
    callTool: vi.fn(async () => ({ ok: true })),
    ownsThread: vi.fn(async () => false),
    event: (method: string, params: Record<string, unknown>) => { events.push({ method, params }); },
  } satisfies CodexCoreLink;
  return { core, events };
}

test("the host runtime decorates threads and sends their tool calls to the core with the claimed cwd and startup", async () => {
  const { process } = fakeProcess();
  const { core } = fakeCore();
  const runtime = new CodexRuntime({ core, catalog: productToolCatalog, process });
  const decorated = runtime.decorateThreadStart({ cwd: "fixture" });
  expect((decorated.dynamicTools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(productToolCatalog.definitions.map((tool) => tool.name));
  runtime.claimThread("owned", "C:/project", { profile: "glm", modelProvider: "ZAI" });
  await runtime.dispatchTool({ threadId: "owned", turnId: "turn", callId: "call", tool: "lane_directory", arguments: { project: "alpha" } });
  expect(core.callTool).toHaveBeenCalledWith("lane_directory", { project: "alpha" }, {
    backend: "codex", conversationId: "owned", cwd: "C:/project", startup: { profile: "glm", modelProvider: "ZAI" },
    requestKey: 'codex:["owned","turn","call"]',
  });
  await expect(runtime.dispatchTool({ threadId: "stranger", turnId: "t", callId: "c", tool: "lane_directory", arguments: { project: "alpha" } }))
    .rejects.toThrow(/not owned/u);
});

test("tool calls the App Server sends on the host's own connection go to the core too", async () => {
  const fake = fakeProcess();
  const { core } = fakeCore();
  const runtime = new CodexRuntime({ core, process: fake.process });
  await runtime.start();
  runtime.claimThread("owned", "C:/project");
  await expect(fake.serverRequest("item/tool/call", { threadId: "owned", turnId: "t", callId: "c", tool: "lane_directory", arguments: { project: "alpha" } }))
    .resolves.toMatchObject({ success: true });
  expect(core.callTool).toHaveBeenCalledOnce();
});

test("visible clients are reported as absolute counts and summarized in hello", async () => {
  const { process } = fakeProcess();
  const { core, events } = fakeCore();
  const runtime = new CodexRuntime({ core, process });
  runtime.claimThread("a", "C:/a");
  runtime.openThreadClient("a");
  runtime.openThreadClient("a");
  runtime.closeThreadClient("a");
  runtime.claimThread("b");
  expect(events).toEqual([
    { method: "threadClients", params: { threadId: "a", visibleClients: 1 } },
    { method: "threadClients", params: { threadId: "a", visibleClients: 2 } },
    { method: "threadClients", params: { threadId: "a", visibleClients: 1 } },
  ]);
  expect(runtime.hello({ instanceId: "host-1", pid: 9, build: "build-1" })).toEqual({
    protocolVersion: CODEX_HOST_PROTOCOL_VERSION, instanceId: "host-1", pid: 9, build: "build-1", appServer: "ready",
    threads: [{ threadId: "a", visibleClients: 1 }, { threadId: "b", visibleClients: 0 }],
  });
});

test("only the two notifications the backend consumes are forwarded, from either source", async () => {
  const fake = fakeProcess();
  const { core, events } = fakeCore();
  const runtime = new CodexRuntime({ core, process: fake.process });
  await runtime.start();
  fake.notify("turn/completed", { threadId: "a" });
  fake.notify("item/started", { threadId: "a" });
  runtime.observeNotification("thread/status/changed", { threadId: "b", status: { type: "idle" } });
  runtime.observeNotification("turn/started", { threadId: "b" });
  expect(events).toEqual([
    { method: "observe", params: { method: "turn/completed", params: { threadId: "a" } } },
    { method: "observe", params: { method: "thread/status/changed", params: { threadId: "b", status: { type: "idle" } } } },
  ]);
});

test("an App Server recovery reports the state and offers every claimed thread a chance", async () => {
  const fake = fakeProcess();
  const { core, events } = fakeCore();
  const runtime = new CodexRuntime({ core, process: fake.process });
  await runtime.start();
  runtime.claimThread("a");
  fake.transportLoss();
  fake.reconnect("same_endpoint");
  expect(events).toEqual([
    { method: "appServer", params: { state: "recovering" } },
    { method: "appServer", params: { state: "ready" } },
    { method: "opportunity", params: { threadIds: ["a"] } },
  ]);
});

test("core requests are limited to the four App Server methods and pass the account gate", async () => {
  const fake = fakeProcess();
  const { core } = fakeCore();
  const runtime = new CodexRuntime({ core, process: fake.process, accountConnectionFile: "unused-fixture-path" });
  await expect(runtime.appServerRequest("thread/read", { threadId: "a" })).resolves.toEqual({ answeredBy: "app-server", method: "thread/read" });
  await expect(runtime.appServerRequest("account/logout", {})).rejects.toThrow(/not allowed/u);
  runtime.accountGate!.hold();
  await expect(runtime.appServerRequest("turn/start", { threadId: "a" })).rejects.toBeInstanceOf(AccountError);
  await expect(runtime.appServerRequest("thread/read", { threadId: "a" })).resolves.toBeDefined();
  expect(fake.request).not.toHaveBeenCalledWith("turn/start", expect.anything());
});

// A respawned App Server listens on a new port. The bridges read the endpoint for every new TUI
// connection, so it has to be the process's current one; the host outlives core restarts, so a
// stale value would otherwise last until someone replaced the host by hand.
test("the endpoint bridges connect to follows the App Server across a respawn", async () => {
  const fake = fakeProcess();
  let current = "ws://127.0.0.1:1";
  Object.defineProperty(fake.process, "endpoint", { get: () => current });
  const runtime = new CodexRuntime({ core: fakeCore().core, process: fake.process });
  await runtime.start();
  expect(runtime.endpoint).toBe("ws://127.0.0.1:1");
  current = "ws://127.0.0.1:2";
  fake.reconnect("respawned");
  expect(runtime.endpoint).toBe("ws://127.0.0.1:2");
});

test("a thread this host claimed is owned at once; any other is the core's answer", async () => {
  const { process } = fakeProcess();
  const { core } = fakeCore();
  core.ownsThread.mockResolvedValueOnce(true);
  const runtime = new CodexRuntime({ core, process });
  runtime.claimThread("claimed");
  expect(runtime.ownsThread("claimed")).toBe(true);
  await expect(runtime.ownsThread("bound-elsewhere")).resolves.toBe(true);
  expect(core.ownsThread).toHaveBeenCalledWith("bound-elsewhere");
});
