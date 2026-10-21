import { request as httpRequest } from "node:http";

import { afterEach, expect, test, vi } from "vitest";

import { LocalRouterServer } from "../../src/process/local-server.js";
import type { ContinueBackend } from "../../src/router/continue-after-switch.js";

// Spec 2026-10-21-continue-after-account-switch.md: one handler behind two entries, the board's
// (and the 问答 page's, which shares its origin and token) and a loopback one the account service
// calls on behalf of its own page.

const servers: LocalRouterServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

async function start(configured = true) {
  const continueAfterSwitch = vi.fn(async (backend: ContinueBackend) => ({ backend, notified: ["alpha/a"], queued: [], skipped: [] }));
  const server = new LocalRouterServer({
    tools: { call: vi.fn() } as never, instanceId: "continue",
    dashboardState: () => ({ lanes: [] }),
    ...(configured ? { continueAfterSwitch } : {}),
  });
  servers.push(server);
  const discovery = await server.start();
  return { discovery, continueAfterSwitch };
}

/** Raw HTTP, so the test sets every header itself, Origin included. */
function send(url: string, options: { method: string; path: string; headers?: Record<string, string>; body?: string }) {
  const target = new URL(url);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = httpRequest({ host: target.hostname, port: target.port, method: options.method, path: options.path, headers: options.headers ?? {} }, (incoming) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => { body += chunk; });
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
    });
    outgoing.on("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

async function tokenOf(url: string): Promise<string> {
  const state = await send(url, { method: "GET", path: "/dashboard/state" });
  return (JSON.parse(state.body) as { actionToken: string }).actionToken;
}

function boardPress(url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return send(url, {
    method: "POST", path: "/dashboard/lanes/continue-after-switch",
    headers: { origin: url, "x-lane-router-action": "continue-after-switch", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("acceptance 3: the board's press needs the page's origin, its action header and its token, and acts on nothing else", async () => {
  const x = await start();
  const actionToken = await tokenOf(x.discovery.url);
  const pressed = await boardPress(x.discovery.url, { backend: "claude", actionToken });
  expect(pressed.status).toBe(200);
  expect(JSON.parse(pressed.body)).toEqual({ result: { backend: "claude", notified: ["alpha/a"], queued: [], skipped: [] } });
  expect(x.continueAfterSwitch).toHaveBeenCalledExactlyOnceWith("claude");

  for (const [why, body, headers] of [
    ["no token", { backend: "claude" }, {}],
    ["another token", { backend: "claude", actionToken: "forged" }, {}],
    ["another origin", { backend: "claude", actionToken }, { origin: "http://evil.example" }],
    ["another action", { backend: "claude", actionToken }, { "x-lane-router-action": "open" }],
  ] as const) {
    expect((await boardPress(x.discovery.url, body, headers)).status, why).toBe(403);
  }
  expect(x.continueAfterSwitch).toHaveBeenCalledTimes(1);
});

test("a backend the action does not know is refused on both entries before anything is sent", async () => {
  const x = await start();
  const actionToken = await tokenOf(x.discovery.url);
  expect((await boardPress(x.discovery.url, { backend: "zcode", actionToken })).status).toBe(400);
  expect((await boardPress(x.discovery.url, { backend: "claude", actionToken, lanes: ["alpha/a"] })).status).toBe(400);
  const local = await send(x.discovery.url, { method: "POST", path: "/lanes/continue-after-switch", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend: "dsh" }) });
  expect(local.status).toBe(400);
  expect(x.continueAfterSwitch).not.toHaveBeenCalled();
});

test("the loopback entry takes a local program's request and refuses a page's", async () => {
  const x = await start();
  const local = await send(x.discovery.url, { method: "POST", path: "/lanes/continue-after-switch", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend: "codex" }) });
  expect(local.status).toBe(200);
  expect(JSON.parse(local.body)).toEqual({ result: { backend: "codex", notified: ["alpha/a"], queued: [], skipped: [] } });
  const page = await send(x.discovery.url, {
    method: "POST", path: "/lanes/continue-after-switch",
    headers: { "content-type": "application/json", origin: x.discovery.url }, body: JSON.stringify({ backend: "codex" }),
  });
  expect(page.status).toBe(403);
  expect(x.continueAfterSwitch).toHaveBeenCalledExactlyOnceWith("codex");
});

test("a Router without the action says so on both entries, and its board state still hands out no token for it", async () => {
  const x = await start(false);
  const local = await send(x.discovery.url, { method: "POST", path: "/lanes/continue-after-switch", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend: "claude" }) });
  expect(local.status).toBe(404);
  const board = await boardPress(x.discovery.url, { backend: "claude", actionToken: "x" });
  expect(board.status).toBe(404);
  const state = JSON.parse((await send(x.discovery.url, { method: "GET", path: "/dashboard/state" })).body) as Record<string, unknown>;
  expect(state.actionToken).toBeUndefined();
});
