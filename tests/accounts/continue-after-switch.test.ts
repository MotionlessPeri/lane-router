import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { AccountError } from "../../src/accounts/contracts.js";
import { AccountHttpServer } from "../../src/accounts/http-server.js";
import { routerContinueClient } from "../../src/accounts/router-continue.js";
import { AccountSwitchService } from "../../src/accounts/switch-service.js";
import { LocalRouterServer } from "../../src/process/local-server.js";

// Spec 2026-10-21-continue-after-account-switch.md, option A: the account page presses its own
// backend, same origin and same guard as every other account action, and the backend forwards to
// the Router's loopback entry it finds through the Router's discovery file.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function serve(lanes?: { continueAfterSwitch: (backend: "claude" | "codex") => Promise<unknown> }) {
  const accounts = { listPublic: () => [], loginStatus: () => ({ state: "idle" }), startLogin: vi.fn(async () => {}), cancelLogin: vi.fn(async () => {}) };
  const service = new AccountSwitchService({ source: { grant: async () => { throw Error("unused"); } }, expected: ["router", "company"], saveDesired: async () => {} });
  const http = new AccountHttpServer({ accounts, service, token: "x".repeat(43), ...(lanes === undefined ? {} : { lanes }) });
  const url = await http.start();
  cleanup.push(() => http.close());
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/api/lanes/continue-after-switch`, {
    method: "POST", body: JSON.stringify(body), headers: { Origin: url, "Content-Type": "application/json", "X-Account-Action": "1", ...headers },
  });
  return { post };
}

const RESULT = { backend: "claude", notified: ["alpha/a"], queued: ["alpha/b"], skipped: [] };

test("the account page's press reaches the lanes through its own backend, behind the same guard as every account action", async () => {
  const continueAfterSwitch = vi.fn(async () => RESULT);
  const x = await serve({ continueAfterSwitch });
  const pressed = await x.post({ backend: "claude" });
  expect(pressed.status).toBe(200);
  expect(await pressed.json()).toEqual({ result: RESULT });
  expect(continueAfterSwitch).toHaveBeenCalledExactlyOnceWith("claude");

  expect((await x.post({ backend: "claude" }, { "X-Account-Action": "0" })).status).toBe(403);
  expect((await x.post({ backend: "claude" }, { Origin: "http://evil.example" })).status).toBe(403);
  expect(continueAfterSwitch).toHaveBeenCalledTimes(1);
});

test("a backend it does not know, or anything besides the backend, is refused before the Router is asked", async () => {
  const continueAfterSwitch = vi.fn(async () => RESULT);
  const x = await serve({ continueAfterSwitch });
  for (const body of [{ backend: "zcode" }, {}, { backend: "codex", lanes: ["alpha/a"] }]) {
    const refused = await x.post(body);
    expect(refused.status, JSON.stringify(body)).toBe(409);
    expect(await refused.json()).toEqual({ error: "INVALID_REQUEST" });
  }
  expect(continueAfterSwitch).not.toHaveBeenCalled();
});

test("a Router that cannot be reached is named as such, and a backend without the forwarder has no such route", async () => {
  const x = await serve({ continueAfterSwitch: async () => { throw new AccountError("ROUTER_UNAVAILABLE"); } });
  const unreachable = await x.post({ backend: "codex" });
  expect(unreachable.status).toBe(409);
  expect(await unreachable.json()).toEqual({ error: "ROUTER_UNAVAILABLE" });
  const bare = await serve();
  expect((await bare.post({ backend: "codex" })).status).toBe(404);
});

test("the forwarder finds the Router through its discovery file and calls the loopback entry", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "router-continue-")); cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
  const client = routerContinueClient(dataRoot);
  await expect(client.continueAfterSwitch("codex")).rejects.toMatchObject({ code: "ROUTER_UNAVAILABLE" });

  const continueAfterSwitch = vi.fn(async (backend: "claude" | "codex") => ({ ...RESULT, backend }));
  const router = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: "continue-forward", continueAfterSwitch });
  const discovery = await router.start();
  cleanup.push(() => router.close());
  await writeFile(join(dataRoot, "discovery.json"), JSON.stringify(discovery));
  expect(await client.continueAfterSwitch("codex")).toEqual({ ...RESULT, backend: "codex" });
  expect(continueAfterSwitch).toHaveBeenCalledExactlyOnceWith("codex");
});

test("a Router that refuses the request is reported as a refusal, not as a result", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "router-continue-")); cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
  // Configured without the action, so the loopback entry answers 404.
  const router = new LocalRouterServer({ tools: { call: vi.fn() } as never, instanceId: "continue-refuse" });
  await writeFile(join(dataRoot, "discovery.json"), JSON.stringify(await router.start()));
  cleanup.push(() => router.close());
  await expect(routerContinueClient(dataRoot).continueAfterSwitch("claude")).rejects.toMatchObject({ code: "ROUTER_REFUSED" });
});
