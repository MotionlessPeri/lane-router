import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CLAUDE_LAUNCH_FILE, ClaudeProfiles } from "../../src/accounts/claude-profiles.js";
import { AccountHttpServer } from "../../src/accounts/http-server.js";
import { AccountSwitchService } from "../../src/accounts/switch-service.js";

// Private storage re-applies the Windows ACL through PowerShell on every write and read.
vi.setConfig({ testTimeout: 60_000 });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

const TOKEN = `sk-ant-oat01-fixture-http-${"h".repeat(64)}`;

async function root() {
  const path = await mkdtemp(join(tmpdir(), "claude-http-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function serve(path: string | undefined) {
  const accounts = { listPublic: () => [], loginStatus: () => ({ state: "idle" }), startLogin: vi.fn(async () => {}), cancelLogin: vi.fn(async () => {}) };
  const service = new AccountSwitchService({ source: { grant: async () => { throw Error("unused"); } }, expected: ["router", "company"], saveDesired: async () => {} });
  let claude: ClaudeProfiles | undefined;
  if (path !== undefined) { claude = new ClaudeProfiles({ root: path, now: () => 7 }); await claude.initialize(); }
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

test("adds, selects, unselects and deletes a Claude account over HTTP, and no answer ever carries the token", async () => {
  const path = await root();
  const first = await serve(path);
  const answers: string[] = [];
  const call = async (route: string, body: unknown) => {
    const response = await first.post(route, body);
    const text = await response.text(); answers.push(text);
    expect(response.status, `${route} ${text}`).toBe(200);
    return JSON.parse(text).claude as { profiles: Array<{ id: string; email: string; createdAt: number }>; selectedId: string | null };
  };

  const added = await call("/api/claude/profiles", { email: "alpha@example.invalid", token: TOKEN });
  expect(added).toEqual({ profiles: [{ id: expect.any(String), email: "alpha@example.invalid", createdAt: 7 }], selectedId: null });
  const id = added.profiles[0]!.id;
  expect((await call("/api/claude/select", { profileId: id })).selectedId).toBe(id);

  const shown = await first.state();
  answers.push(shown.text);
  expect(JSON.parse(shown.text).claude).toEqual({ profiles: added.profiles, selectedId: id });
  expect(JSON.parse(await readFile(join(path, CLAUDE_LAUNCH_FILE), "utf8"))).toEqual({ version: 1, email: "alpha@example.invalid", token: TOKEN });

  // A restart of the service finds the account and the selection where it left them.
  await first.close();
  const second = await serve(path);
  const restarted = await second.state();
  answers.push(restarted.text);
  expect(JSON.parse(restarted.text).claude).toEqual({ profiles: added.profiles, selectedId: id });

  const unselected = await second.post("/api/claude/select", {});
  answers.push(await unselected.clone().text());
  expect((await unselected.json()).claude.selectedId).toBeNull();
  await expect(readFile(join(path, CLAUDE_LAUNCH_FILE), "utf8")).rejects.toThrow(/ENOENT/u);
  const deleted = await second.post("/api/claude/profiles/delete", { profileId: id });
  answers.push(await deleted.clone().text());
  expect(deleted.status).toBe(200);
  expect((await deleted.json()).claude).toEqual({ profiles: [], selectedId: null });

  for (const answer of answers) expect(answer).not.toContain("sk-ant-oat");
});

test("the Claude routes keep the page guards and take only their own fields", async () => {
  const f = await serve(await root());
  const route = "/api/claude/profiles";
  const body = { email: "alpha@example.invalid", token: TOKEN };
  expect((await f.post(route, body, { Origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await f.post(route, body, { "X-Account-Action": "0" })).status).toBe(403);
  expect((await f.post(route, body, { "Content-Type": "text/plain" })).status).toBe(403);
  for (const [path, fields] of [
    [route, { email: "alpha@example.invalid" }],
    [route, { ...body, profileId: "claude-x" }],
    [route, { email: 7, token: TOKEN }],
    ["/api/claude/select", { profileId: "claude-x", token: TOKEN }],
    ["/api/claude/profiles/delete", {}],
    ["/api/login", { email: "alpha@example.invalid" }],
  ] as const) {
    // The service's existing answer to a body of the wrong shape: 409 with INVALID_REQUEST.
    const response = await f.post(path, fields);
    const text = await response.text();
    expect(response.status, `${path} ${JSON.stringify(Object.keys(fields))}`).toBe(409);
    expect(JSON.parse(text)).toEqual({ error: "INVALID_REQUEST" });
  }
  expect(f.accounts.startLogin).not.toHaveBeenCalled();
  expect(JSON.parse((await f.state()).text).claude).toEqual({ profiles: [], selectedId: null });

  // Refused by the account rules with a code the page can explain, and the token is not echoed.
  const refused = await f.post(route, { email: "alpha@example.invalid", token: "sk-ant-api03-console-key-not-a-setup-token" });
  expect(refused.status).toBe(409);
  const refusal = await refused.text();
  expect(JSON.parse(refusal)).toEqual({ error: "INVALID_CLAUDE_TOKEN" });
  expect(refusal).not.toContain("console-key");
  expect((await f.post("/api/claude/select", { profileId: "claude-none" })).status).toBe(409);
});

test("a service built without Claude accounts has no Claude state and no Claude routes", async () => {
  const f = await serve(undefined);
  expect(JSON.parse((await f.state()).text)).not.toHaveProperty("claude");
  for (const route of ["/api/claude/profiles", "/api/claude/select", "/api/claude/profiles/delete"]) {
    expect((await f.post(route, { profileId: "claude-x" })).status, route).toBe(404);
  }
});
