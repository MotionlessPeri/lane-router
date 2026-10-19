import type { AddressInfo } from "node:net";

import { afterEach, expect, test, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { isAccountModelRequest } from "../../../src/accounts/switch-gate.js";
import { CodexTuiBridge, type CodexTuiBridgeHost } from "../../../src/adapters/codex/tui-bridge.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function harness(ownsThread: CodexTuiBridgeHost["ownsThread"], admissions = { entered: 0, finished: 0 }) {
  const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => upstreamServer.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve) => upstreamServer.close(() => resolve())));
  const upstreamFrames: Array<Record<string, unknown>> = [];
  upstreamServer.on("connection", (socket) => socket.on("message", (raw) => upstreamFrames.push(JSON.parse(raw.toString()))));
  const host: CodexTuiBridgeHost = {
    endpoint: `ws://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`,
    decorateThreadStart: (params) => params,
    claimThread: vi.fn(), openThreadClient: vi.fn(), closeThreadClient: vi.fn(),
    ownsThread, dispatchTool: vi.fn(), observeNotification: vi.fn(),
    // Counts what the account gate would: every model request let in has to be let out again.
    admitModelRequest: (method) => {
      if (!isAccountModelRequest(method)) return () => undefined;
      admissions.entered += 1;
      let done = false;
      return () => { if (!done) { done = true; admissions.finished += 1; } };
    },
  };
  const bridge = new CodexTuiBridge(host);
  const endpoint = await bridge.start();
  cleanups.push(() => bridge.close());
  const tui = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => { tui.once("open", resolve); tui.once("error", reject); });
  cleanups.push(() => tui.terminate());
  const tuiFrames: Array<Record<string, unknown>> = [];
  tui.on("message", (raw) => tuiFrames.push(JSON.parse(raw.toString())));
  return { tui, upstreamFrames, tuiFrames };
}

// An ownership answer that has to come from the core arrives later than the frames behind it.
// Forwarding those first would let a turn reach the App Server before the resume it depends on.
test("frames behind an ownership question wait for its answer and keep their order", async () => {
  let answer!: (owned: boolean) => void;
  const { tui, upstreamFrames } = await harness(() => new Promise<boolean>((resolve) => { answer = resolve; }));
  tui.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "bound-elsewhere" } }));
  tui.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "bound-elsewhere", input: [] } }));
  await expect.poll(() => typeof answer).toBe("function");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(upstreamFrames).toEqual([]);
  answer(true);
  await expect.poll(() => upstreamFrames.map((frame) => frame.id)).toEqual([1, 2]);
});

// A frame still queued when its TUI goes away must not be let into the account gate: nothing would
// ever let it out, and a gate with work it believes in flight never finishes an account switch.
test("frames processed after their TUI is gone take no account admission with them", async () => {
  let answer!: (owned: boolean) => void;
  const admissions = { entered: 0, finished: 0 };
  const { tui } = await harness(() => new Promise<boolean>((resolve) => { answer = resolve; }), admissions);
  tui.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "bound-elsewhere" } }));
  tui.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "bound-elsewhere", input: [] } }));
  await expect.poll(() => typeof answer).toBe("function");
  tui.terminate();
  await new Promise((resolve) => setTimeout(resolve, 100));
  answer(true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(admissions.finished).toBe(admissions.entered);
});

test("an ownership question the core cannot answer refuses the resume with the reason", async () => {
  const { tui, upstreamFrames, tuiFrames } = await harness(() => Promise.reject(new Error("Lane Router is not running")));
  tui.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "unknown" } }));
  await expect.poll(() => tuiFrames).toEqual([{ id: 1, error: { code: -32600, message: "Lane Router is not running" } }]);
  expect(upstreamFrames).toEqual([]);
});

test("a synchronous answer still refuses a thread that is not owned", async () => {
  const { tui, upstreamFrames, tuiFrames } = await harness(() => false);
  tui.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "foreign" } }));
  await expect.poll(() => tuiFrames).toEqual([{ id: 1, error: { code: -32600, message: "Codex thread is not owned by Lane Router: foreign" } }]);
  expect(upstreamFrames).toEqual([]);
});
