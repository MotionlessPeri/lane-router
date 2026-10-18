import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ManagedAccounts } from "../../src/accounts/managed-login.js";
import type { AccountRpcClient, RpcNotification } from "../../src/accounts/stdio-client.js";
import * as privateStorage from "../../src/accounts/private-storage.js";

// ACLs and atomic writes are separately exercised against the OS in private-storage.test.ts.
vi.mock("../../src/accounts/private-storage.js", async () => {
  const fs = await import("node:fs/promises");
  return {
    ensurePrivateDirectory: (path: string) => fs.mkdir(path, { recursive: true }),
    atomicPrivateJson: (path: string, value: unknown) => fs.writeFile(path, JSON.stringify(value)),
    readPrivateJson: async (path: string) => { try { return JSON.parse(await fs.readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } },
  };
});

function token(user = "user-a", account = "workspace-a", email?: string, generation = 0) {
  return `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3_600, email, generation,
    "https://api.openai.com/auth": { chatgpt_user_id: user, chatgpt_account_id: account, chatgpt_plan_type: "plus" },
  })).toString("base64url")}.fixture`;
}

class Broker implements AccountRpcClient {
  listeners = new Set<(event: RpcNotification) => void>(); closeListeners = new Set<() => void>();
  calls: Array<{ method: string; params: any }> = []; closed = false;
  accessToken = token(); authUrl = "https://auth.openai.com/oauth/authorize?fixture=only";
  getStatus?: (refresh: boolean) => Promise<unknown>;
  async request(method: string, params?: any): Promise<unknown> {
    if (this.closed) throw new Error("sensitive-closed");
    this.calls.push({ method, params });
    if (method === "account/login/start") return { type: "chatgpt", authUrl: this.authUrl, loginId: "fixture-login" };
    if (method === "getAuthStatus") return this.getStatus ? this.getStatus(params.refreshToken) : { authMethod: "chatgpt", authToken: this.accessToken, requiresOpenaiAuth: true };
    if (method === "account/read") return { account: { type: "chatgpt", email: "alice@fixture.invalid", planType: "plus" }, requiresOpenaiAuth: true, workspaceRouting: null };
    throw new Error("unexpected-method");
  }
  complete(success = true, loginId = "fixture-login") { for (const listener of this.listeners) listener({ method: "account/login/completed", params: { loginId, success, error: success ? null : "sensitive-vendor-error", onboardingEntrypoint: null } }); }
  onNotification(listener: (event: RpcNotification) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onClose(listener: () => void) { this.closeListeners.add(listener); return () => { this.closeListeners.delete(listener); }; }
  async close() { if (this.closed) return; this.closed = true; for (const listener of this.closeListeners) listener(); }
}

const roots: string[] = []; const managers: ManagedAccounts[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(options: { loginTimeoutMs?: number; configure?: (broker: Broker) => void; root?: string } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "router-managed-")); if (!options.root) roots.push(root);
  const brokers: Broker[] = []; const homes: string[] = []; const opened: string[] = [];
  const manager = new ManagedAccounts({ root, executable: "unused-fixture", loginTimeoutMs: options.loginTimeoutMs,
    openUrl: async url => { opened.push(url); },
    createClient: async ({ home }) => { const broker = new Broker(); options.configure?.(broker); brokers.push(broker); homes.push(home); return broker; },
  }); managers.push(manager); await manager.initialize(); return { manager, root, brokers, homes, opened };
}
async function login(setup: Awaited<ReturnType<typeof fixture>>, profileId?: string) {
  await setup.manager.startLogin(profileId);
  await expect.poll(() => setup.manager.loginStatus().state).toBe("waiting");
  const broker = setup.brokers.at(-1)!; broker.complete();
  await expect.poll(() => setup.manager.loginStatus().state).toBe("complete");
  return setup.manager.listPublic()[0]!.id;
}

test("login opens official URL in backend, persists metadata only, and does not select a consumer account", async () => {
  const setup = await fixture();
  expect(await setup.manager.startLogin()).toBeUndefined();
  await expect.poll(() => setup.manager.loginStatus().state).toBe("waiting");
  expect(setup.opened).toEqual(["https://auth.openai.com/oauth/authorize?fixture=only"]);
  setup.brokers[0]!.complete(true, "unrelated");
  expect(setup.manager.loginStatus()).toEqual({ state: "waiting" });
  setup.brokers[0]!.complete();
  await expect.poll(() => setup.manager.loginStatus().state).toBe("complete");
  const profiles = setup.manager.listPublic();
  expect(profiles).toHaveLength(1);
  expect(profiles[0]).toMatchObject({ email: "a***@fixture.invalid", plan: "plus" });
  expect(setup.manager.desiredProfileId).toBeUndefined();
  const publicText = JSON.stringify({ profiles, status: setup.manager.loginStatus() });
  for (const value of ["user-a", "workspace-a", "alice@fixture.invalid", setup.root, "auth.openai.com", setup.brokers[0]!.accessToken]) expect(publicText).not.toContain(value);
  const metadata = await readFile(join(setup.root, "profiles.json"), "utf8");
  expect(metadata).not.toContain(setup.brokers[0]!.accessToken);
  expect(metadata).not.toContain("authUrl");
  expect(await readdir(setup.homes[0]!)).not.toContain("auth.json");
});

test.each(["http://auth.openai.com/authorize", "https://auth.openai.com.attacker.invalid/", "https://evil.invalid/", "https://user:password@auth.openai.com/", "https://auth.openai.com:444/"])("rejects non-official auth URL %s without opening browser", async authUrl => {
  const setup = await fixture({ configure: broker => { broker.authUrl = authUrl; } });
  await setup.manager.startLogin();
  await expect.poll(() => setup.manager.loginStatus().state).toBe("failed");
  expect(setup.manager.loginStatus()).toEqual({ state: "failed", error: "LOGIN_FAILED" });
  expect(setup.opened).toEqual([]); expect(setup.brokers[0]!.closed).toBe(true);
});

test.each(["cancel", "failure", "timeout", "exit"])("%s releases only the pending login owner and returns safe status", async reason => {
  const setup = await fixture({ loginTimeoutMs: reason === "timeout" ? 100 : 2_000 });
  await setup.manager.startLogin();
  await expect.poll(() => setup.manager.loginStatus().state).toBe("waiting");
  await expect(setup.manager.startLogin()).rejects.toThrow("LOGIN_BUSY");
  if (reason === "cancel") await setup.manager.cancelLogin();
  if (reason === "failure") setup.brokers[0]!.complete(false);
  if (reason === "exit") await setup.brokers[0]!.close();
  await expect.poll(() => setup.manager.loginStatus().state).toBe(reason === "cancel" ? "cancelled" : "failed");
  expect(setup.brokers[0]!.closed).toBe(true);
  expect(setup.manager.listPublic()).toEqual([]);
  expect(JSON.stringify(setup.manager.loginStatus())).not.toContain("sensitive");
});

test("cache avoids redundant token reads and concurrent forced refreshes share one official refresh", async () => {
  const setup = await fixture(); const id = await login(setup); const owner = setup.brokers[0]!;
  const initial = await setup.manager.grant(id);
  expect(owner.calls.filter(call => call.method === "getAuthStatus")).toHaveLength(1);
  let release!: (value: unknown) => void;
  owner.getStatus = () => new Promise(resolve => { release = resolve; });
  const refreshes = [setup.manager.grant(id, true), setup.manager.grant(id, true), setup.manager.grant(id, true)];
  await expect.poll(() => owner.calls.filter(call => call.method === "getAuthStatus").length).toBe(2);
  const replacement = token("user-a", "workspace-a", undefined, 1);
  release({ authMethod: "chatgpt", authToken: replacement, requiresOpenaiAuth: true });
  const results = await Promise.all(refreshes);
  expect(results.every(result => result.accessToken === replacement)).toBe(true);
  expect(initial.accessToken).not.toBe(replacement);
  expect(owner.calls.filter(call => call.method === "getAuthStatus").map(call => call.params)).toEqual([{ includeToken: true, refreshToken: false }, { includeToken: true, refreshToken: true }]);
});

test("refresh identity mismatch and vendor failure never authorize from metadata", async () => {
  const setup = await fixture(); const id = await login(setup); const owner = setup.brokers[0]!;
  owner.accessToken = token("other-user", "workspace-a", "alice@fixture.invalid");
  await expect(setup.manager.grant(id, true)).rejects.toThrow("IDENTITY_MISMATCH");
  owner.getStatus = async () => { throw new Error("sensitive-token-in-rpc-error"); };
  await expect(setup.manager.grant(id, true)).rejects.toThrow(/^AUTH_REQUIRED$/);
});

test("duplicate identity replaces one profile, stops prior owner, and never calls revoking logout", async () => {
  const setup = await fixture(); const id = await login(setup); await setup.manager.saveDesired(id);
  await login(setup);
  expect(setup.manager.listPublic()).toHaveLength(1);
  expect(setup.manager.listPublic()[0]!.id).toBe(id);
  expect(setup.brokers[0]!.closed).toBe(true);
  expect(setup.brokers[1]!.closed).toBe(false);
  expect(setup.homes[0]).not.toBe(setup.homes[1]);
  expect(setup.brokers.flatMap(broker => broker.calls).some(call => call.method === "account/logout")).toBe(false);
  expect(setup.manager.desiredProfileId).toBe(id);
});

test("reauthorization with a different stable identity keeps original profile and owner", async () => {
  const setup = await fixture(); const id = await login(setup);
  await setup.manager.startLogin(id);
  await expect.poll(() => setup.manager.loginStatus().state).toBe("waiting");
  setup.brokers[1]!.accessToken = token("other-user", "workspace-a", "alice@fixture.invalid");
  setup.brokers[1]!.complete();
  await expect.poll(() => setup.manager.loginStatus().state).toBe("failed");
  expect(setup.manager.loginStatus().error).toBe("IDENTITY_MISMATCH");
  expect(setup.brokers[1]!.closed).toBe(true); expect(setup.brokers[0]!.closed).toBe(false);
  expect((await setup.manager.grant(id)).identity.userId).toBe("user-a");
});

test("restart reloads metadata but rechecks official access identity before granting", async () => {
  const setup = await fixture(); const id = await login(setup); await setup.manager.saveDesired(id); await setup.manager.close();
  const restart = await fixture({ root: setup.root, configure: broker => { broker.accessToken = token("other-user"); } });
  expect(restart.manager.desiredProfileId).toBe(id);
  expect(restart.manager.listPublic()).toHaveLength(1);
  expect(restart.brokers).toHaveLength(0);
  await expect(restart.manager.grant(id)).rejects.toThrow("IDENTITY_MISMATCH");
  expect(restart.homes).toEqual([setup.homes[0]]);
});

test("one profile serializes fresh token reads before installing a replacement owner", async () => {
  const setup = await fixture(); const id = await login(setup); const old = setup.brokers[0]!;
  let release!: (value: unknown) => void;
  old.getStatus = () => new Promise(resolve => { release = resolve; });
  const pending = setup.manager.grant(id, true);
  await expect.poll(() => typeof release).toBe("function");
  await setup.manager.startLogin(id);
  await expect.poll(() => setup.manager.loginStatus().state).toBe("waiting");
  setup.brokers[1]!.complete();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(old.closed).toBe(false);
  release({ authMethod: "chatgpt", authToken: token(), requiresOpenaiAuth: true });
  await pending;
  await expect.poll(() => setup.manager.loginStatus().state).toBe("complete");
  expect(old.closed).toBe(true);
});

test("an exited owner is reopened from its isolated home before the next refresh", async () => {
  const setup = await fixture(); const id = await login(setup);
  await setup.brokers[0]!.close();
  await expect(setup.manager.grant(id, true)).resolves.toMatchObject({ identity: { userId: "user-a" } });
  expect(setup.brokers).toHaveLength(2);
  expect(setup.homes[1]).toBe(setup.homes[0]);
});

test("a cached access token nearing expiry is refreshed by its one owner", async () => {
  const setup = await fixture(); const id = await login(setup); const owner = setup.brokers[0]!;
  const realNow = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 3_550_000);
  try {
    owner.accessToken = token("user-a", "workspace-a", undefined, 2);
    await setup.manager.grant(id);
    expect(owner.calls.filter(call => call.method === "getAuthStatus").at(-1)!.params.refreshToken).toBe(true);
  } finally { clock.mockRestore(); }
});

test("failed browser launch cleans up without publishing URL or native exception", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-managed-")); roots.push(root); const owner = new Broker();
  const manager = new ManagedAccounts({ root, executable: "fixture", createClient: async () => owner, openUrl: async () => { throw new Error("sensitive-auth-url"); } });
  managers.push(manager); await manager.initialize(); await manager.startLogin();
  await expect.poll(() => manager.loginStatus().state).toBe("failed");
  expect(manager.loginStatus()).toEqual({ state: "failed", error: "LOGIN_FAILED" });
  expect(owner.closed).toBe(true);
});

test("cancellation during broker startup closes the late-created owned child", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-managed-")); roots.push(root); const owner = new Broker();
  let release!: (owner: Broker) => void;
  const manager = new ManagedAccounts({ root, executable: "fixture", createClient: () => new Promise(resolve => { release = resolve; }), openUrl: async () => {} });
  managers.push(manager); await manager.initialize(); await manager.startLogin();
  await expect.poll(() => typeof release).toBe("function");
  const cancelled = manager.cancelLogin(); release(owner); await cancelled;
  expect(owner.closed).toBe(true);
  expect(manager.loginStatus().state).toBe("cancelled");
  expect(owner.calls).toEqual([]);
});

test("login completion received before the start response is not lost", async () => {
  const setup = await fixture({ configure: broker => {
    const request = broker.request.bind(broker);
    broker.request = async (method, params) => { if (method === "account/login/start") broker.complete(); return request(method, params); };
  } });
  await setup.manager.startLogin();
  await expect.poll(() => setup.manager.loginStatus().state).toBe("complete");
  expect(setup.manager.listPublic()).toHaveLength(1);
});

test("shutdown closes existing owner before waiting on a login replacement queued behind refresh", async () => {
  const setup = await fixture(); const id = await login(setup); const old = setup.brokers[0]!;
  old.getStatus = () => new Promise((_, reject) => { old.onClose(() => reject(new Error("fixture-owned-process-exit"))); });
  const pending = expect(setup.manager.grant(id, true)).rejects.toThrow("AUTH_REQUIRED");
  await setup.manager.startLogin(id);
  await expect.poll(() => setup.manager.loginStatus().state).toBe("waiting");
  setup.brokers[1]!.complete();
  await new Promise(resolve => setTimeout(resolve, 20));
  const closing = setup.manager.close();
  try { await expect.poll(() => old.closed, { timeout: 500 }).toBe(true); }
  finally { await old.close(); await closing; await pending; }
  expect(setup.brokers.every(broker => broker.closed)).toBe(true);
});

test("profile lookup matches both stable user and workspace, never the display email", async () => {
  const setup = await fixture(); const id = await login(setup);
  const identity = { userId: "user-a", accountId: "workspace-a", email: "different@fixture.invalid", plan: "unknown" };
  expect(setup.manager.findProfile(identity)).toBe(id);
  expect(setup.manager.findProfile({ ...identity, userId: "user-b" })).toBeUndefined();
  expect(setup.manager.findProfile({ ...identity, accountId: "workspace-b" })).toBeUndefined();
  expect(setup.brokers[0]!.calls.filter(call => call.method === "getAuthStatus")).toHaveLength(1);
});

test("restart refreshes through the owner when only expired persisted access is available", async () => {
  const setup = await fixture(); const id = await login(setup); await setup.manager.close();
  const expired = `fixture.${Buffer.from(JSON.stringify({ exp: 1, "https://api.openai.com/auth": { chatgpt_user_id: "user-a", chatgpt_account_id: "workspace-a" } })).toString("base64url")}.fixture`;
  const restart = await fixture({ root: setup.root, configure: broker => { broker.getStatus = async refresh => ({ authMethod: "chatgpt", authToken: refresh ? token() : expired, requiresOpenaiAuth: true }); } });
  const grants = await Promise.all([restart.manager.grant(id), restart.manager.grant(id, true)]);
  expect(grants.every(grant => grant.identity.userId === "user-a")).toBe(true);
  expect(restart.brokers[0]!.calls.filter(call => call.method === "getAuthStatus")).toHaveLength(1);
});

test("shutdown during the metadata transaction also closes the newly installed owner", async () => {
  const setup = await fixture(); const id = await login(setup);
  const persist = privateStorage.atomicPrivateJson;
  let release!: () => void;
  const delayed = vi.spyOn(privateStorage, "atomicPrivateJson").mockImplementationOnce(async (path, value) => {
    await new Promise<void>(resolve => { release = resolve; }); await persist(path, value);
  });
  try {
    await setup.manager.startLogin(id);
    await expect.poll(() => setup.manager.loginStatus().state).toBe("waiting");
    setup.brokers[1]!.complete();
    await expect.poll(() => typeof release).toBe("function");
    const closing = setup.manager.close(); release(); await closing;
    expect(setup.brokers.every(broker => broker.closed)).toBe(true);
  } finally { delayed.mockRestore(); }
});
