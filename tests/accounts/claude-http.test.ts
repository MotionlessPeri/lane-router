import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeProfiles } from "../../src/accounts/claude-profiles.js";
import { AccountHttpServer } from "../../src/accounts/http-server.js";
import { AccountSwitchService } from "../../src/accounts/switch-service.js";

// Private storage re-applies the Windows ACL through PowerShell on every write and read.
vi.setConfig({ testTimeout: 90_000 });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

const FAKE = fileURLToPath(new URL("../fixtures/accounts/fake-claude.mjs", import.meta.url));
const token = (kind: string) => `sk-ant-oat01-fixture-${kind}-${"h".repeat(48)}`;

async function root() {
  const path = await mkdtemp(join(tmpdir(), "claude-http-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function serve(path: string | undefined) {
  const accounts = { listPublic: () => [], loginStatus: () => ({ state: "idle" }), startLogin: vi.fn(async () => {}), cancelLogin: vi.fn(async () => {}) };
  const service = new AccountSwitchService({ source: { grant: async () => { throw Error("unused"); } }, expected: ["router", "company"], saveDesired: async () => {} });
  let claude: ClaudeProfiles | undefined;
  if (path !== undefined) {
    claude = new ClaudeProfiles({ root: path, now: () => 7, usage: { command: { executable: process.execPath, args: [FAKE] } } });
    await claude.initialize();
  }
  const http = new AccountHttpServer({ accounts, service, token: "x".repeat(43), ...(claude === undefined ? {} : { claude }) });
  const url = await http.start();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await http.close(); } };
  cleanup.push(close);
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}${route}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { Origin: url, "Content-Type": "application/json", "X-Account-Action": "1", ...headers },
  });
  const state = async () => { const response = await fetch(`${url}/api/state`); return { status: response.status, text: await response.text() }; };
  return { url, post, state, close, accounts };
}

test("adds an account, reads its usage, keeps both across a restart and deletes it, with no token in any answer", async () => {
  const path = await root();
  const first = await serve(path);
  const answers: string[] = [];
  const call = async (server: Awaited<ReturnType<typeof serve>>, route: string, body: unknown) => {
    const response = await server.post(route, body);
    const text = await response.text(); answers.push(text);
    expect(response.status, `${route} ${text}`).toBe(200);
    return JSON.parse(text).claude as { profiles: Array<Record<string, unknown> & { id: string }> };
  };

  const added = await call(first, "/api/claude/profiles", { email: "alpha@example.invalid", token: token("good") });
  expect(added).toEqual({ profiles: [{ id: expect.any(String), email: "alpha@example.invalid", createdAt: 7, usage: null, usageError: null, refreshing: false }] });
  const id = added.profiles[0]!.id;

  const refreshed = await call(first, "/api/claude/usage/refresh", { profileId: id });
  const reading = { checkedAt: 7, fiveHour: { utilization: 0.37, resetsAt: 1_792_400_000 }, sevenDay: { utilization: 0.12, resetsAt: 1_792_900_000 } };
  expect(refreshed.profiles[0]).toMatchObject({ id, usage: reading, usageError: null, refreshing: false });
  const shown = await first.state();
  answers.push(shown.text);
  expect(JSON.parse(shown.text).claude).toEqual(refreshed);
  expect(JSON.parse(shown.text).claude).not.toHaveProperty("selectedId");

  await first.close();
  const second = await serve(path);
  const restarted = await second.state();
  answers.push(restarted.text);
  expect(JSON.parse(restarted.text).claude.profiles[0]).toMatchObject({ id, usage: reading });

  expect(await call(second, "/api/claude/profiles/delete", { profileId: id })).toEqual({ profiles: [] });
  expect(existsSync(join(path, "claude-launch.json"))).toBe(false);
  for (const answer of answers) expect(answer).not.toContain("sk-ant-oat");
});

test("a failed reading is that account's state, answered like any other", async () => {
  const f = await serve(await root());
  const added = await (await f.post("/api/claude/profiles", { email: "bad@example.invalid", token: token("bad") })).json();
  const response = await f.post("/api/claude/usage/refresh", { profileId: added.claude.profiles[0].id });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(JSON.parse(text).claude.profiles[0]).toMatchObject({ usage: null, usageError: { at: 7, code: "USAGE_FAILED" } });
  expect(text).not.toContain("sk-ant-oat");
});

test("the Claude routes keep the page guards, take only their own fields, and selecting is gone", async () => {
  const f = await serve(await root());
  const route = "/api/claude/profiles";
  const body = { email: "alpha@example.invalid", token: token("good") };
  expect((await f.post(route, body, { Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await f.post(route, body, { "X-Account-Action": "0" })).status).toBe(403);
  expect((await f.post(route, body, { "Content-Type": "text/plain" })).status).toBe(403);
  expect((await f.post("/api/claude/usage/refresh", { profileId: "claude-x" }, { Origin: "https://foreign.invalid" })).status).toBe(403);
  for (const [path, fields] of [
    [route, { email: "alpha@example.invalid" }],
    [route, { ...body, profileId: "claude-x" }],
    [route, { email: 7, token: token("good") }],
    ["/api/claude/usage/refresh", {}],
    ["/api/claude/usage/refresh", { profileId: "claude-x", token: token("good") }],
    ["/api/claude/profiles/delete", {}],
    ["/api/login", { email: "alpha@example.invalid" }],
  ] as const) {
    // The service's existing answer to a body of the wrong shape: 409 with INVALID_REQUEST.
    const response = await f.post(path, fields);
    const text = await response.text();
    expect(response.status, `${path} ${JSON.stringify(Object.keys(fields))}`).toBe(409);
    expect(JSON.parse(text)).toEqual({ error: "INVALID_REQUEST" });
  }
  expect((await f.post("/api/claude/select", { profileId: "claude-x" })).status).toBe(404);
  expect(f.accounts.startLogin).not.toHaveBeenCalled();
  expect(JSON.parse((await f.state()).text).claude).toEqual({ profiles: [] });

  const refused = await f.post(route, { email: "alpha@example.invalid", token: "sk-ant-api03-console-key-not-a-setup-token" });
  expect(refused.status).toBe(409);
  const refusal = await refused.text();
  expect(JSON.parse(refusal)).toEqual({ error: "INVALID_CLAUDE_TOKEN" });
  expect(refusal).not.toContain("console-key");
  expect((await f.post("/api/claude/usage/refresh", { profileId: "claude-none" })).status).toBe(409);
});

test("a service built without Claude accounts has no Claude state and no Claude routes", async () => {
  const f = await serve(undefined);
  expect(JSON.parse((await f.state()).text)).not.toHaveProperty("claude");
  for (const route of ["/api/claude/profiles", "/api/claude/usage/refresh", "/api/claude/profiles/delete"]) {
    expect((await f.post(route, { profileId: "claude-x" })).status, route).toBe(404);
  }
});
