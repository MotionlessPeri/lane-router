import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { runRouterProcess } from "../../src/process/main.js";
import { LocalRouterClient } from "../../src/process/local-client.js";
import { openKnowledgeStore } from "../../src/modules/knowledge/index.js";

// The core's whole Codex side is the host link's hub; the host itself runs in another process.
vi.mock("../../src/process/codex-host-hub.js", () => ({ CodexHostHub: class {
  readonly client = { request: vi.fn(async () => ({ data: [], nextCursor: null })), isConnected: () => false, onNotification: () => () => {} };
  connect() {} hasVisibleClient() { return false; }
  onReady(handler: () => void) { queueMicrotask(handler); return () => {}; }
  status() { return { connected: false, hostBuild: null, coreBuild: "fixture" }; }
  close() {}
} }));
vi.mock("../../src/process/ensure-codex-host.js", () => ({ ensureCodexHost: async () => undefined }));
vi.mock("../../src/process/codex-profiles.js", () => ({ defaultCodexModelProvider: () => "fixture", listCodexProfiles: () => [], listCodexModelProviders: () => [], profileModelProvider: () => "fixture" }));

const roots: string[] = [];
const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const runtime of running.splice(0)) await runtime.close().catch(() => {});
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "knowledge-startup-")); roots.push(path);
  writeFileSync(join(path, "config.json"), "{}"); vi.stubEnv("LANE_ROUTER_CONFIG", join(path, "config.json"));
  return path;
}
async function boot(path: string, issues?: boolean) {
  const runtime = await runRouterProcess({ dataRoot: path, issues } as any); running.push(runtime);
  const discovery = JSON.parse(readFileSync(join(path, "discovery.json"), "utf8"));
  const client = new LocalRouterClient(async () => discovery.url);
  return { runtime, url: discovery.url as string, call: (name: string, args: Record<string, unknown>, context = caller) => client.call(name, args, context) as Promise<any> };
}
const caller = { backend: "codex", conversationId: "fake-thread", requestKey: "fixture-rpc" } as const;
const other = { backend: "codex", conversationId: "other-thread", requestKey: "fixture-other" } as const;
const page = { title: "lane_send 群发", summary: "一次发给多条 lane", body: "Router 拒收 cc 字段。" };

test("the standalone Router opens knowledge.sqlite and serves both knowledge tools", async () => {
  const path = root(); const x = await boot(path);
  expect(existsSync(join(path, "knowledge.sqlite"))).toBe(true);
  await x.call("lane_attach_current", { address: "fixture/work", role_description: "Fixture role" });
  const checked = await x.call("lane_kb_record", { step: "check", ...page });
  const created = await x.call("lane_kb_record", { step: "commit", checkId: checked.checkId, operationKey: "create", decision: { kind: "create", ...page } });
  expect(created.viewUrl).toBe(`${x.url}/knowledge/${created.pageId}`);
  expect(await x.call("lane_kb_search", { query: "cc" })).toMatchObject({ hits: [{ pageId: created.pageId }] });
});

test("core-only assembly never creates the knowledge database", async () => {
  const path = root(); const x = await boot(path, false);
  await expect(x.call("lane_kb_search", {})).rejects.toThrow(/unknown method/);
  expect(existsSync(join(path, "knowledge.sqlite"))).toBe(false);
});

test.each(["corrupt", "future"])("12. a %s knowledge database leaves communication, issues and graphs working and is not replaced", async kind => {
  const path = root(); const databasePath = join(path, "knowledge.sqlite");
  if (kind === "corrupt") writeFileSync(databasePath, "not a database");
  else { const store = openKnowledgeStore(databasePath); store.close(); const db = new Database(databasePath); db.prepare("UPDATE kb_schema_version SET version=999").run(); db.close(); }
  const before = readFileSync(databasePath);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const x = await boot(path);
  expect(stderr.mock.calls.some(([line]) => String(line).startsWith("KB_UNAVAILABLE"))).toBe(true); stderr.mockRestore();
  await x.call("lane_attach_current", { address: "fixture/work", role_description: "Fixture role" });
  await x.call("lane_attach_current", { address: "fixture/other", role_description: "Other role" }, other);
  await expect(x.call("lane_kb_search", {})).rejects.toMatchObject({ code: "KB_UNAVAILABLE" });
  await expect(x.call("lane_kb_record", { step: "check", ...page })).rejects.toMatchObject({ code: "KB_UNAVAILABLE" });
  expect((await x.call("lane_directory", { project: "fixture" })).map((lane: { address: string }) => lane.address).sort()).toEqual(["fixture/other", "fixture/work"]);
  const [sent] = await x.call("lane_send", { target: "fixture/other", kind: "normal", body: "still delivering" });
  await expect(x.call("lane_ack", { message_ids: [sent.id] }, other)).resolves.toMatchObject({ resolved: [sent.id] });
  await expect(x.call("lane_issue_read", {})).resolves.toBeDefined();
  await expect(x.call("lane_graph_create", { operationKey: "graph", title: "Graph" })).resolves.toMatchObject({ lockValid: true });
  expect(readFileSync(databasePath)).toEqual(before);
});
