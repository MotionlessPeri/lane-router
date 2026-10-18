import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { runRouterProcess } from "../../src/process/main.js";
import { LocalRouterClient } from "../../src/process/local-client.js";
import { CodexBackend } from "../../src/backends/codex-backend.js";
import { MailboxStore } from "../../src/router/mailbox-store.js";
import { NotificationPump } from "../../src/router/notification-pump.js";
import { openIssuesModule, openIssueStore } from "../../src/modules/issues/index.js";
import { openGraphStore } from "../../src/modules/graphs/index.js";

const fake = vi.hoisted(() => ({ options: [] as any[], stopError: false, modelError: false, moduleStartError: false, moduleCloseError: false, events: [] as string[] }));
vi.mock("../../src/adapters/codex/codex-runtime.js", () => ({ createCodexRuntime: (options: any) => {
  fake.options.push(options);
  const client = { request: vi.fn(async () => { if (fake.modelError) throw new Error("fixture models fail"); return { data: [], nextCursor: null }; }), isConnected: () => false, onNotification: () => () => {} };
  return { client, endpoint: "ws://127.0.0.1:1", start: async () => "ws://127.0.0.1:1",
    stop: async () => { fake.events.push("codex-stop"); if (fake.stopError) throw new Error("fixture stop fail"); },
    backend: new CodexBackend({ client, resolveLane: () => undefined }),
    decorateThreadStart: (params: any) => params, claimThread: () => {}, openThreadClient: () => {}, closeThreadClient: () => {}, ownsThread: () => false,
  };
} }));
vi.mock("../../src/process/codex-profiles.js", () => ({ defaultCodexModelProvider: () => "fixture", listCodexProfiles: () => [], listCodexModelProviders: () => [], profileModelProvider: () => "fixture" }));
vi.mock("../../src/modules/issues/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../src/modules/issues/index.js")>();
  return { ...original, openIssuesModule: vi.fn((options: any) => {
    const module = original.openIssuesModule(options);
    return { service: module.service, start: async () => { fake.events.push("issues-start"); await module.start(); if (fake.moduleStartError) throw new Error("fixture recovery fail"); }, close: async () => { fake.events.push("issues-close"); await module.close(); if (fake.moduleCloseError) throw new Error("fixture module close fail"); } };
  }) };
});

const roots: string[] = [];
const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  fake.stopError = false; fake.modelError = false; fake.moduleStartError = false; fake.moduleCloseError = false;
  for (const runtime of running.splice(0)) await runtime.close().catch(() => {});
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  fake.events.length = 0; fake.options.length = 0;
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "issue-startup-task5-")); roots.push(path);
  writeFileSync(join(path, "config.json"), "{}"); vi.stubEnv("LANE_ROUTER_CONFIG", join(path, "config.json"));
  return path;
}
async function boot(path: string, issues?: boolean) {
  const runtime = await runRouterProcess({ dataRoot: path, issues } as any); running.push(runtime);
  const discovery = JSON.parse(readFileSync(join(path, "discovery.json"), "utf8"));
  return { runtime, client: new LocalRouterClient(async () => discovery.url) };
}
const caller = { backend: "codex", conversationId: "fake-thread", requestKey: "fixture-rpc" } as const;

test("standalone explicitly assembles issues after reconciliation and exposes product RPC", async () => {
  const path = root();
  const original = MailboxStore.prototype.reconcile;
  vi.spyOn(MailboxStore.prototype, "reconcile").mockImplementation(function (...args) { fake.events.push("reconcile"); return original.apply(this, args); });
  const x = await boot(path);
  expect(fake.options[0].catalog.definitions).toHaveLength(13);
  expect(fake.events.indexOf("reconcile")).toBeLessThan(fake.events.indexOf("issues-start"));
  expect(existsSync(join(path, "issues.sqlite"))).toBe(true);
  expect(existsSync(join(path, "graphs.sqlite"))).toBe(true);
  await x.client.call("lane_attach_current", { address: "fixture/work", role_description: "Fixture role" }, caller);
  const graph = await x.client.call("lane_graph_create", { operationKey: "graph-create", title: "Graph" }, caller) as any;
  expect(graph.lockValid).toBe(true); expect(graph.viewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/graphs\//);
  const saved = await x.client.call("lane_issue_publish", { operationKey: "publish", title: "Choose", kind: "question", body: "Which?" }, caller) as any;
  expect(await x.client.call("lane_issue_read", { issueId: saved.issueId }, caller)).toMatchObject({ thread: { id: saved.issueId } });
  const discovery = JSON.parse(readFileSync(join(path, "discovery.json"), "utf8"));
  const listing = await fetch(`${discovery.url}/issues/api/threads`);
  expect(listing.status).toBe(200);
  expect(await listing.json()).toMatchObject({ result: { items: [{ id: saved.issueId }] }, actionToken: expect.any(String) });
  await x.runtime.close();
  expect(fake.events.indexOf("issues-close")).toBeLessThan(fake.events.indexOf("codex-stop"));
  expect(existsSync(join(path, "router.lock"))).toBe(false);
});

test("core-only assembly never constructs the module or creates its database", async () => {
  const path = root();
  const before = vi.mocked(openIssuesModule).mock.calls.length;
  const x = await boot(path, false);
  expect(fake.options[0].catalog.definitions).toHaveLength(5);
  expect(vi.mocked(openIssuesModule).mock.calls).toHaveLength(before);
  expect(existsSync(join(path, "issues.sqlite"))).toBe(false);
  expect(existsSync(join(path, "graphs.sqlite"))).toBe(false);
  await expect(x.client.call("lane_directory", { project: "fixture" }, caller)).resolves.toEqual([]);
  await expect(x.client.call("lane_issue_read", {}, caller)).rejects.toThrow(/unknown method/);
  const discovery = JSON.parse(readFileSync(join(path, "discovery.json"), "utf8"));
  expect((await fetch(`${discovery.url}/issues/api/threads`)).status).toBe(404);
  await expect(x.client.call("lane_graph_read", {}, caller)).rejects.toThrow(/unknown method/);
  expect((await fetch(`${discovery.url}/graphs/api/any`)).status).toBe(404);
});

test.each(["corrupt", "future"])("%s graph module failure leaves core and issues available without replacing graphs", async kind => {
  const path = root(); const databasePath = join(path, "graphs.sqlite");
  if (kind === "corrupt") writeFileSync(databasePath, "not a database");
  else { const store = openGraphStore(databasePath); store.close(); const db = new Database(databasePath); db.prepare("UPDATE graph_schema_version SET version=999").run(); db.close(); }
  const before = readFileSync(databasePath); const x = await boot(path);
  await x.client.call("lane_attach_current", { address: "fixture/work", role_description: "Fixture role" }, caller);
  await expect(x.client.call("lane_graph_read", {}, caller)).rejects.toMatchObject({ code: "GRAPHS_UNAVAILABLE" });
  await expect(x.client.call("lane_issue_read", {}, caller)).resolves.toBeDefined();
  expect(readFileSync(databasePath)).toEqual(before);
});

test.each(["corrupt", "future"])("%s module failure leaves core available and returns ISSUES_UNAVAILABLE without replacement", async kind => {
  const path = root(); const databasePath = join(path, "issues.sqlite");
  if (kind === "corrupt") writeFileSync(databasePath, "not a database");
  else { const store = openIssueStore(databasePath); store.close(); const db = new Database(databasePath); db.prepare("UPDATE issue_schema_version SET version=999").run(); db.close(); }
  const before = readFileSync(databasePath);
  const x = await boot(path);
  await expect(x.client.call("lane_directory", { project: "fixture" }, caller)).resolves.toEqual([]);
  await expect(x.client.call("lane_issue_read", {}, caller)).rejects.toThrow(/ISSUES_UNAVAILABLE/);
  await expect(x.client.call("lane_issue_read", {}, caller)).rejects.toMatchObject({ code: "ISSUES_UNAVAILABLE" });
  const discovery = JSON.parse(readFileSync(join(path, "discovery.json"), "utf8"));
  const response = await fetch(`${discovery.url}/issues/api/threads`);
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: "ISSUES_UNAVAILABLE" });
  expect(readFileSync(databasePath)).toEqual(before);
});

test("abnormal startup and shutdown release core lock and database even when runtime stop fails", async () => {
  const path = root(); fake.modelError = true;
  await expect(runRouterProcess({ dataRoot: path })).rejects.toThrow("fixture models fail");
  expect(existsSync(join(path, "router.lock"))).toBe(false);
  fake.modelError = false;
  const x = await boot(path); fake.stopError = true;
  await expect(x.runtime.close()).rejects.toThrow("fixture stop fail");
  expect(existsSync(join(path, "router.lock"))).toBe(false);
  const db = new Database(join(path, "router.sqlite")); db.close();
});

test("failed module recovery closes its started worker and leaves its configured entry unavailable", async () => {
  const path = root(); fake.moduleStartError = true;
  const x = await boot(path);
  expect(fake.events).toContain("issues-close");
  await expect(x.client.call("lane_directory", { project: "fixture" }, caller)).resolves.toEqual([]);
  await expect(x.client.call("lane_issue_read", {}, caller)).rejects.toThrow(/ISSUES_UNAVAILABLE/);
});

test("module close errors still release the runtime and core lock", async () => {
  const path = root(); const x = await boot(path); fake.moduleCloseError = true;
  await expect(x.runtime.close()).rejects.toThrow("fixture module close fail");
  expect(fake.events).toContain("codex-stop");
  expect(existsSync(join(path, "router.lock"))).toBe(false);
});

test("startup failure after module start drains and closes its database before releasing core", async () => {
  const path = root();
  vi.spyOn(NotificationPump.prototype, "onStartup").mockRejectedValueOnce(new Error("fixture startup fail"));
  await expect(runRouterProcess({ dataRoot: path })).rejects.toThrow("fixture startup fail");
  expect(fake.events).toEqual(["issues-start", "issues-close", "codex-stop"]);
  expect(existsSync(join(path, "router.lock"))).toBe(false);
  const db = new Database(join(path, "issues.sqlite")); db.close();
});
