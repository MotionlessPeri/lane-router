#!/usr/bin/env node
// A fake `zcode app-server --stdio` for tests: newline JSON on stdout, requests on stdin, and the
// same three boot-time server->client requests the real server makes. Any argv is accepted so the
// spawn default-args path can be exercised against this same script.
import { createInterface } from "node:readline";

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
const replyError = (id, code, message) => process.stdout.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
const notify = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);

const bootAnswers = {};
const waitingAsks = new Map();
let nextServerId = 1;
const ask = (method) => {
  const id = `server-${nextServerId++}`;
  waitingAsks.set(id, method);
  process.stdout.write(`${JSON.stringify({ id, method, params: {} })}\n`);
};
ask("session/requestRuntimePreferences");
ask("interaction/requestOfficialMcpAuthHeaders");

let sessionCounter = 0;
let lastAccountConfig = null;
const replyOrReport = {
  "provider/updateAccountConfig": (params) => {
    lastAccountConfig = params;
    return {
      receivedRevision: params.revision,
      providerCount: Object.keys(params.providers ?? {}).length,
      status: "received",
    };
  },
  "session/create": () => ({ sessionId: `sess-fake-${++sessionCounter}` }),
  "session/subscribe": () => ({}),
  "session/send": (params) => {
    const turnNumber = sessionCounter;
    process.stdout.write(`${JSON.stringify({ method: "session/event", params: { sessionId: params.sessionId, seq: 1, payload: { type: "input.executionStartedAt", turnNumber, input: params.content } } })}\n`);
    process.stdout.write(`${JSON.stringify({ method: "session/event", params: { sessionId: params.sessionId, seq: 2, payload: { type: "text_delta", text: "HELLO " } } })}\n`);
    process.stdout.write(`${JSON.stringify({ method: "session/event", params: { sessionId: params.sessionId, seq: 3, payload: { type: "text_delta", text: "FROM FAKE" } } })}\n`);
    process.stdout.write(`${JSON.stringify({ method: "session/event", params: { sessionId: params.sessionId, seq: 4, payload: { type: "model_complete", content: "HELLO FROM FAKE", stopReason: "stop", usage: {} } } })}\n`);
    return { accepted: true, turnId: `turn-${turnNumber}` };
  },
  "session/stop": () => ({}),
  "fixture/report": () => ({
    argv: process.argv.slice(2),
    env: {
      builtin: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? null,
      personal: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ?? null,
    },
    bootAnswers,
    lastAccountConfig,
  }),
};

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim().length === 0) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && message.method === undefined) {
    const method = waitingAsks.get(message.id);
    if (method !== undefined) bootAnswers[method] = message.result ?? message.error ?? null;
    return;
  }
  if (message.id !== undefined && message.method !== undefined) {
    const handler = replyOrReport[message.method];
    if (handler === undefined) {
      replyError(message.id, -32601, `no such method: ${message.method}`);
      return;
    }
    try { reply(message.id, handler(message.params ?? {})); }
    catch (error) { replyError(message.id, -32000, String(error?.message ?? error)); }
    return;
  }
  if (message.method === "fixture/shutdown") {
    process.exit(0);
  }
  // Other notifications from the client are ignored, exactly as a server would.
});
