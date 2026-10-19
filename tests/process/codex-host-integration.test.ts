import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import WebSocket from "ws";

import { runCodexHost } from "../../src/process/codex-host.js";
import { LocalRouterClient } from "../../src/process/local-client.js";
import { runRouterProcess } from "../../src/process/main.js";

// Real core and real host in this process, sharing one temporary data root, with the fake App
// Server standing in for Codex. Nothing here starts a detached process or touches a shared Router.
vi.setConfig({ testTimeout: 60_000 });
vi.mock("../../src/process/codex-profiles.js", () => ({
  defaultCodexModelProvider: () => "openai", listCodexModelProviders: () => [], listCodexProfiles: () => [], profileModelProvider: () => "openai",
}));

const FAKE_APP_SERVER = join(process.cwd(), "tests", "fixtures", "codex", "fake-app-server.mjs");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup(); } catch { /* best effort */ } }
  vi.unstubAllEnvs();
});

type Closable = { close(): Promise<void> };

function world() {
  const root = mkdtempSync(join(tmpdir(), "codex-host-it-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "config.json"), "{}");
  vi.stubEnv("LANE_ROUTER_CONFIG", join(root, "config.json"));
  vi.stubEnv("LANE_ROUTER_ACCOUNTS_CONNECTION", undefined);
  const statusFile = join(root, "fake-status.json");
  const logFile = join(root, "fake-requests.log");
  const state = { ensured: 0, core: undefined as Closable | undefined, host: undefined as Awaited<ReturnType<typeof runCodexHost>> | undefined };
  const startCore = async () => {
    const core = await runRouterProcess({ dataRoot: root, ensureCodexHost: async () => { state.ensured += 1; }, build: "build-a" });
    state.core = core;
    cleanups.push(() => core.close());
    return core;
  };
  const startHost = async (build = "build-a") => {
    const host = await runCodexHost({
      dataRoot: root, build, reconnectDelaysMs: [50],
      command: { executable: process.execPath, prefixArgs: [FAKE_APP_SERVER], env: { FAKE_CODEX_STATUS_FILE: statusFile, FAKE_CODEX_LOG_FILE: logFile } },
    });
    state.host = host;
    cleanups.push(() => host.close());
    return host;
  };
  const rpc = () => {
    const discovery = JSON.parse(readFileSync(join(root, "discovery.json"), "utf8")) as { url: string };
    return { url: discovery.url, client: new LocalRouterClient(async () => discovery.url) };
  };
  const setStatus = (statuses: Record<string, "idle" | "active">) => writeFileSync(statusFile, JSON.stringify(statuses));
  const requests = (): Array<{ method: string; params: Record<string, unknown> }> => existsSync(logFile)
    ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const linked = (value = true) => vi.waitFor(() => expect(state.host?.link.connected).toBe(value), { timeout: 10_000 });
  return { root, state, startCore, startHost, rpc, setStatus, requests, linked };
}

/** A stand-in for the stock Codex TUI: one WebSocket to a host bridge, speaking the App Server protocol. */
async function tui(endpoint: string) {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  cleanups.push(() => socket.terminate());
  const frames: Array<Record<string, any>> = [];
  socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  let nextId = 1000;
  const find = <T>(pick: () => T | undefined): Promise<T> => vi.waitFor(() => {
    const value = pick();
    if (value === undefined) throw new Error("not yet");
    return value;
  }, { timeout: 10_000 });
  const request = (method: string, params: Record<string, unknown>) => {
    const id = ++nextId;
    socket.send(JSON.stringify({ id, method, params }));
    return find(() => frames.find((frame) => frame.id === id && frame.method === undefined));
  };
  const startTurn = async (threadId: string, text: string) => {
    const started = await request("turn/start", { threadId, input: [{ type: "text", text }] });
    const turnId = started.result.turn.id as string;
    return find(() => frames.find((frame) => frame.method === "turn/completed" && frame.params.turn.id === turnId)?.params.turn.items[0]);
  };
  const toolResult = (item: Record<string, any>) => JSON.parse(item.response.result.contentItems[0].text);
  return { socket, request, startTurn, toolResult, newThread: async (cwd: string) => (await request("thread/start", { cwd })).result.thread.id as string };
}

test("a Codex conversation keeps talking while the core is down, gets an immediate tool error, and resumes lane tools after", async () => {
  const w = world();
  await w.startCore();
  const host = await w.startHost();
  await w.linked();
  const codex = await tui(host.discovery.codexEndpoint);
  const threadId = await codex.newThread(w.root);
  const attached = await codex.startTurn(threadId, 'tool:lane_attach_current {"address":"alpha/codex","role_description":"Codex lane"}');
  expect(attached.response.result.success).toBe(true);
  const before = codex.toolResult(await codex.startTurn(threadId, 'tool:lane_directory {"project":"alpha"}'));
  expect(before).toMatchObject([{ address: "alpha/codex", binding: { generation: 1 } }]);

  await w.state.core!.close();
  await w.linked(false);

  expect(await codex.startTurn(threadId, "still here?")).toEqual({ type: "agentMessage", text: "echo: still here?" });
  const startedAt = Date.now();
  const refused = await codex.startTurn(threadId, 'tool:lane_directory {"project":"alpha"}');
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(refused.response.error.message).toMatch(/Lane Router is not running/u);

  await w.startCore();
  await w.linked();
  const after = codex.toolResult(await codex.startTurn(threadId, 'tool:lane_directory {"project":"alpha"}'));
  expect(after[0].binding).toEqual(before[0].binding);
  // A new core has observed no turn yet, as on the Claude side after a restart: reachable, unconfirmed.
  expect(after[0].reach).toMatchObject({ state: "unconfirmed", lastLifecycleAt: null });
  expect(w.state.host!.discovery.pid).toBe(host.discovery.pid);
});

test("mail left pending across a core restart is delivered once the host links back, under the same binding", async () => {
  const w = world();
  await w.startCore();
  const host = await w.startHost();
  await w.linked();
  const codex = await tui(host.discovery.codexEndpoint);
  const threadId = await codex.newThread(w.root);
  await codex.startTurn(threadId, 'tool:lane_attach_current {"address":"alpha/codex","role_description":"Codex lane"}');
  const sender = { backend: "codex", conversationId: "sender-thread", requestKey: "attach-sender" } as const;
  await w.rpc().client.call("lane_attach_current", { address: "alpha/sender", role_description: "Sender" }, sender);

  // Busy, so the notification is deferred and the message stays pending through the restart.
  w.setStatus({ [threadId]: "active" });
  const [message] = await w.rpc().client.call("lane_send", { target: "alpha/codex", kind: "normal", body: "while you were busy" }, { ...sender, requestKey: "send-1" }) as Array<{ id: string }>;
  await vi.waitFor(() => expect(w.requests().some((entry) => entry.method === "thread/read" && entry.params.threadId === threadId)).toBe(true));
  expect(w.requests().some((entry) => entry.method === "turn/start" && entry.params.threadId === threadId && JSON.stringify(entry.params).includes(message!.id))).toBe(false);

  await w.state.core!.close();
  await w.linked(false);
  w.setStatus({ [threadId]: "idle" });
  await w.startCore();
  await w.linked();

  await vi.waitFor(() => expect(w.requests().some((entry) => entry.method === "turn/start" && entry.params.threadId === threadId
    && JSON.stringify(entry.params).includes(message!.id))).toBe(true), { timeout: 10_000 });
  const directory = await w.rpc().client.call("lane_directory", { project: "alpha" }, { ...sender, requestKey: "dir" }) as Array<{ address: string; binding: { generation: number } }>;
  expect(directory.find((lane) => lane.address === "alpha/codex")?.binding.generation).toBe(1);
});

test("a tool call in flight when the core exits fails as unknown rather than hanging", async () => {
  const w = world();
  await w.startCore();
  const host = await w.startHost();
  await w.linked();
  const holder = { backend: "codex", conversationId: "holder-thread", requestKey: "attach-holder" } as const;
  await w.rpc().client.call("lane_attach_current", { address: "alpha/held", role_description: "Held" }, holder);
  w.setStatus({ "holder-thread": "active" });
  const codex = await tui(host.discovery.codexEndpoint);
  const threadId = await codex.newThread(w.root);

  // The takeover waits for the holder's turn to end, so the call is still inside the core.
  const takeover = codex.startTurn(threadId, 'tool:lane_attach_current {"address":"alpha/held"}');
  await vi.waitFor(() => expect(w.requests().some((entry) => entry.method === "thread/read" && entry.params.threadId === "holder-thread")).toBe(true));
  await w.state.core!.close();

  const outcome = await takeover;
  expect(outcome.response.error.message).toMatch(/result is unknown/u);
});

test("restore presence and reach follow the link and the TUI, and a lost host is ensured again", async () => {
  const w = world();
  await w.startCore();
  const host = await w.startHost();
  await w.linked();
  expect(w.state.ensured).toBe(1);
  const codex = await tui(host.discovery.codexEndpoint);
  const threadId = await codex.newThread(w.root);
  await codex.startTurn(threadId, 'tool:lane_attach_current {"address":"alpha/codex","role_description":"Codex lane"}');
  const resumeInfo = async () => {
    const response = await fetch(`${w.rpc().url}/lanes/resume-info?address=alpha/codex`);
    return (await response.json() as { result: { restorePresence: string; reach: { state: string } } }).result;
  };
  await vi.waitFor(async () => expect(await resumeInfo()).toMatchObject({ restorePresence: "online", reach: { state: "live" } }));

  codex.socket.close();
  await vi.waitFor(async () => expect(await resumeInfo()).toMatchObject({ restorePresence: "offline" }));

  await host.close();
  await vi.waitFor(async () => expect(await resumeInfo()).toMatchObject({ restorePresence: "unavailable", reach: { state: "no_channel" } }));
  await vi.waitFor(() => expect(w.state.ensured).toBe(2));

  const replacement = await w.startHost();
  expect(replacement.discovery.instanceId).not.toBe(host.discovery.instanceId);
  await w.linked();
  // The core still holds what it observed before, timestamps and all; only the link and the
  // visible clients are new facts.
  await vi.waitFor(async () => expect(await resumeInfo()).toMatchObject({ restorePresence: "offline", reach: { state: "live" } }));
});

test("the core starts and serves without any Codex host, reporting Codex as unavailable", async () => {
  const w = world();
  await w.startCore();
  expect(existsSync(join(w.root, "discovery.json"))).toBe(true);
  const caller = { backend: "codex", conversationId: "lonely-thread", requestKey: "attach" } as const;
  await w.rpc().client.call("lane_attach_current", { address: "alpha/lonely", role_description: "No host" }, caller);
  const response = await fetch(`${w.rpc().url}/lanes/resume-info?address=alpha/lonely`);
  expect((await response.json() as { result: unknown }).result).toMatchObject({ restorePresence: "unavailable", reach: { state: "no_channel" } });
  expect(w.state.ensured).toBe(1);
});
