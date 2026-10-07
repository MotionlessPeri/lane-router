import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ZcodeDriver, type ZcodeClientPort, type ZcodeProcessPort } from "../../src/adapters/zcode/driver/driver.js";
import { LocalRouterServer } from "../../src/process/local-server.js";
import { spawnHeadlessZcodeLane } from "../../src/process/zcode-lane-spawner.js";
import { spawnZcodeLaneCli } from "../../src/process/zcode-spawn-cli.js";

const PLAN = { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3", reasoningLevel: "high" as const };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A driver double over the mock-client seam: records wire requests; boot reads a real temp builtin file. */
async function fakeDriver() {
  const root = await mkdtemp(join(tmpdir(), "lane-router-spawn-"));
  roots.push(root);
  const builtin = join(root, "builtin.json");
  await writeFile(builtin, JSON.stringify({ revision: 3 }), "utf8");
  let counter = 0;
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const client: ZcodeClientPort = {
    request: async (method: string, params?: unknown) => {
      calls.push({ method, args: (params ?? {}) as Record<string, unknown> });
      if (method === "provider/updateAccountConfig") return { receivedRevision: (params as { revision: string }).revision, providerCount: 8, status: "received" };
      if (method === "session/create") return { sessionId: `sess-${++counter}` };
      return {};
    },
    onEvent: () => () => undefined,
    onServerRequest: () => () => undefined,
  };
  const driver = new ZcodeDriver({
    launch: { command: "unused" },
    plan: PLAN,
    builtinConfigPath: builtin,
    personalConfigPath: join(root, "personal.json"),
    client,
    process: { start: async () => undefined, shutdown: async () => undefined, state: "ready" } satisfies ZcodeProcessPort,
  });
  return { driver, calls };
}

describe("spawnHeadlessZcodeLane", () => {
  it("creates a yolo session on the cwd and attaches it through the ToolService path", async () => {
    const { driver, calls } = await fakeDriver();
    const toolCalls: Array<{ name: string; args: Record<string, unknown>; context: Record<string, unknown> }> = [];
    const result = await spawnHeadlessZcodeLane({
      driver,
      callTool: (name, args, context) => {
        toolCalls.push({ name, args: { ...args }, context: { ...context } });
        return { address: args.address };
      },
      input: { address: "alpha/design", role: "keeps the build green", cwd: "C:/repo", model: "GLM-5.3" },
      newRequestKey: () => "key-1",
    });
    expect(result).toEqual({ sessionId: "sess-1", address: "alpha/design" });
    const create = calls.find((call) => call.method === "session/create")!;
    expect(create.args).toMatchObject({
      workspace: { workspacePath: "C:/repo", workspaceKey: "C:/repo" },
      mode: "yolo",
    });
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      name: "lane_attach_current",
      args: { address: "alpha/design", role_description: "keeps the build green", model: "GLM-5.3" },
      context: { backend: "zcode", conversationId: "sess-1", cwd: "C:/repo", requestKey: "zcode-spawn:key-1" },
    });
  });

  it("stops the session it created when the attach is refused", async () => {
    const { driver } = await fakeDriver();
    const stopped: string[] = [];
    driver.stop = async (sessionId) => { stopped.push(sessionId); };
    await expect(spawnHeadlessZcodeLane({
      driver,
      callTool: async () => { throw new Error("LANE_ALREADY_BOUND: The lane is actively bound"); },
      input: { address: "alpha/design", role: "r", cwd: "C:/repo" },
    })).rejects.toThrow(/actively bound/u);
    expect(stopped).toEqual(["sess-1"]);
  });
});

describe("lane-router-zcode-spawn CLI", () => {
  function dependencies(response: { status: number; body: unknown }) {
    const writes: string[] = [];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? ({} as RequestInit) });
      return new Response(JSON.stringify(response.body), { status: response.status });
    }) as unknown as typeof globalThis.fetch;
    return {
      writes, calls, fetch,
      deps: {
        dataRoot: "C:/data",
        routerUrl: async () => "http://127.0.0.1:4200/",
        fetch,
        write: (text: string) => { writes.push(text); },
      },
    };
  }

  it("posts the invocation to the Router and reports the session id", async () => {
    const { writes, deps, calls } = dependencies({ status: 200, body: { result: { sessionId: "sess-9", address: "alpha/design" } } });
    await spawnZcodeLaneCli(["alpha/design", "--role", "keeps the build green", "--cwd", "C:/repo", "--model", "GLM-5.3"], deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4200/zcode/spawn");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      address: "alpha/design", role: "keeps the build green", cwd: "C:/repo", model: "GLM-5.3",
    });
    expect(writes.join("")).toContain("sess-9");
  });

  it.each([
    ["missing address", ["--role", "r", "--cwd", "C:/repo"]],
    ["missing role", ["alpha/design", "--cwd", "C:/repo"]],
    ["missing cwd", ["alpha/design", "--role", "r"]],
    ["an unknown flag", ["alpha/design", "--role", "r", "--cwd", "C:/repo", "--terminal", "wt"]],
    ["a malformed address", ["not-a-lane-address", "--role", "r", "--cwd", "C:/repo"]],
  ])("refuses %s without touching the Router", async (_label, args) => {
    const { deps, calls } = dependencies({ status: 200, body: {} });
    await expect(spawnZcodeLaneCli(args, deps)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("surfaces the Router's refusal, including the disabled-driver case", async () => {
    const { deps } = dependencies({ status: 503, body: { error: "The zcode driver is not enabled; configure zcode.driver in the Router config to spawn headless lanes" } });
    await expect(spawnZcodeLaneCli(["alpha/design", "--role", "r", "--cwd", "C:/repo"], deps))
      .rejects.toThrow(/driver is not enabled/u);
  });
});

describe("Router /zcode/spawn endpoint", () => {
  it("creates the lane when the driver is enabled and answers 503 when it is not", async () => {
    const { driver } = await fakeDriver();
    const spawn = vi.fn((input: { address: string; role: string; cwd: string; model?: string }) =>
      spawnHeadlessZcodeLane({
        driver, callTool: async () => ({}), input, newRequestKey: () => "k",
      }));
    const tools = { call: vi.fn(async () => ({})) };
    const server = new LocalRouterServer({
      tools: tools as never,
      codex: { endpoint: "ws://127.0.0.1:1" } as never,
      instanceId: "test",
      zcodeSpawnLane: spawn as never,
    });
    const discovery = await server.start();
    const created = await fetch(`${discovery.url}/zcode/spawn`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "alpha/design", role: "keeps the build green", cwd: "C:/repo" }),
    });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { result: { sessionId: string } }).result.sessionId).toMatch(/^sess-/u);
    await server.close();

    const bare = new LocalRouterServer({
      tools: tools as never,
      codex: { endpoint: "ws://127.0.0.1:1" } as never,
      instanceId: "test",
    });
    const bareDiscovery = await bare.start();
    const refused = await fetch(`${bareDiscovery.url}/zcode/spawn`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "alpha/design", role: "r", cwd: "C:/repo" }),
    });
    expect(refused.status).toBe(503);
    await bare.close();
  });

  it("rejects malformed spawn bodies", async () => {
    const tools = { call: vi.fn(async () => ({})) };
    const server = new LocalRouterServer({
      tools: tools as never,
      codex: { endpoint: "ws://127.0.0.1:1" } as never,
      instanceId: "test",
      zcodeSpawnLane: (async () => ({ sessionId: "s", address: "a" })) as never,
    });
    const discovery = await server.start();
    const responses = await Promise.all([
      fetch(`${discovery.url}/zcode/spawn`, { method: "POST", body: "{}" }),
      fetch(`${discovery.url}/zcode/spawn`, { method: "POST", body: JSON.stringify({ address: "bad address", role: "r", cwd: "c" }) }),
      fetch(`${discovery.url}/zcode/spawn`, { method: "POST", body: JSON.stringify({ address: "alpha/design", role: "", cwd: "c" }) }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    await server.close();
  });
});
