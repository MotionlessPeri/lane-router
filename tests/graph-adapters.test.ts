import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { setupIssueRouter } from "./fixtures/issues/router.js";
import { GraphsService, openGraphStore } from "../src/modules/graphs/index.js";
import { runGraphCli } from "../src/modules/graphs/cli.js";
import { graphToolArgsSchemas } from "../src/modules/graphs/tool-schema.js";
import { bindBuiltinTools, productToolCatalog } from "../src/application/builtin-tools.js";
import { LocalRouterClient } from "../src/process/local-client.js";
import { LocalRouterServer } from "../src/process/local-server.js";
import { ToolService } from "../src/tools/tool-service.js";
import { GraphsHttp } from "../src/modules/graphs/http.js";

const closes: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function setup(enabled = true, available = true) {
  const x = setupIssueRouter(); closes.push(() => x.dispose());
  const store = openGraphStore(join(x.root, "graphs.sqlite")); closes.push(() => store.close());
  const service = new GraphsService({ store, lanes: x.core }); const tools = new ToolService(x.core);
  let origin = "http://127.0.0.1";
  const applicationTools = bindBuiltinTools(tools, x.service, productToolCatalog, service, () => origin);
  const assetsDirectory = join(x.root, "assets"); mkdirSync(join(assetsDirectory, "assets"), { recursive: true });
  writeFileSync(join(assetsDirectory, "index.html"), "<html>Graph viewer</html>");
  writeFileSync(join(assetsDirectory, "assets", "viewer.js"), "// viewer");
  writeFileSync(join(assetsDirectory, "asset-manifest.json"), JSON.stringify(["assets/viewer.js"]));
  const server = new LocalRouterServer({ tools, applicationTools, ...(enabled ? { graphs: { service: available ? service : undefined, assetsDirectory } } : {}),
    codex: { endpoint: "ws://127.0.0.1:1" } as never, instanceId: randomUUID() });
  origin = (await server.start()).url; closes.push(() => server.close());
  const client = new LocalRouterClient(async () => origin);
  return { ...x, service, origin, client, get: (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init) };
}
test("four graph tools share schemas, reject identity injection, and expose no agent force-unlock", () => {
  expect(productToolCatalog.jsonTools().filter(tool => tool.name.startsWith("lane_graph_"))).toHaveLength(4);
  expect(() => graphToolArgsSchemas.lane_graph_create.parse({ operationKey: "a", title: "A", laneId: "spoof" })).toThrow();
  expect(() => graphToolArgsSchemas.lane_graph_lock.parse({ operationKey: "a", graphId: "g", action: "force-unlock" })).toThrow();
});
test("real RPC and JSON-file CLI create, discover and atomically edit the same shared graph", async () => {
  const x = await setup(); const path = join(x.root, "graph.json");
  writeFileSync(path, JSON.stringify({ operationKey: "create", title: "Rendering" })); let output = "";
  await runGraphCli(["create", "--json-file", path], { client: x.client, env: { CODEX_THREAD_ID: x.caller.conversationId }, cwd: x.root, write: s => { output = s; } });
  const created = JSON.parse(output);
  expect(created.viewUrl).toBe(`${x.origin}/graphs/${created.graphId}`);
  await x.client.call("lane_graph_apply", { operationKey: "edit", graphId: created.graphId, lockId: created.lockId,
    changes: [{ op: "upsert_node", id: "materials", label: "材质" }] }, x.caller);
  const response = await x.get(`/graphs/api/${created.graphId}`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).result.document.nodes[0].label).toBe("材质");
  expect((await x.get(`/graphs/${created.graphId}`)).status).toBe(200);
  expect((await x.get("/graphs/assets/viewer.js")).status).toBe(200);
  expect((await x.get("/graphs/assets/unknown.js")).status).toBe(404);
  expect((await x.get(`/graphs/api/${created.graphId}`, { method: "POST" })).status).toBe(404);
  expect(await x.client.call("lane_graph_read", {}, x.caller)).toMatchObject({ graphs: [{ id: created.graphId }] });
});
test("machine-only force unlock checks Origin, content type and exact expected lock", async () => {
  const x = await setup(); const a = x.service.create(x.caller, { operationKey: "create", title: "A" });
  const path = `/graphs/admin/${a.graphId}/force-unlock`;
  const post = (headers: Record<string, string>, expectedLock = a.lockId) => x.get(path, { method: "POST", headers, body: JSON.stringify({ expectedLock }) });
  expect((await post({ origin: x.origin, "content-type": "application/json" })).status).toBe(403);
  expect((await post({ "content-type": "text/plain" })).status).toBe(400);
  expect((await post({ "content-type": "application/json" }, "stale")).status).toBe(409);
  expect(x.service.read(a.graphId).lock?.lockId).toBe(a.lockId);
  let output = "";
  await runGraphCli(["force-unlock", "--id", a.graphId, "--expected-lock", a.lockId!], { client: x.client, resolveUrl: async () => x.origin, env: {}, write: s => { output = s; } });
  expect(JSON.parse(output).unlocked).toBe(true); expect(x.service.read(a.graphId).lock).toBeNull();
});
test("omitted module stays absent and unavailable module fails explicitly", async () => {
  const absent = await setup(false); expect((await absent.get("/graphs/any")).status).toBe(404);
  const unavailable = await setup(true, false); const res = await unavailable.get("/graphs/api/any");
  expect(res.status).toBe(503); expect(await res.json()).toMatchObject({ code: "GRAPHS_UNAVAILABLE" });
});
test("CLI requires current process identity and rejects extra flags before calling", async () => {
  const client = { call: vi.fn() }; const readJsonFile = () => ({ operationKey: "new", title: "New" });
  await expect(runGraphCli(["create", "--json-file", "input"], { client, env: {}, readJsonFile })).rejects.toThrow(/CODEX_THREAD_ID/);
  await expect(runGraphCli(["create", "--json-file", "input", "--lane", "spoof"], { client, env: { CODEX_THREAD_ID: "thread" }, readJsonFile })).rejects.toThrow(/Usage/);
  expect(client.call).not.toHaveBeenCalled();
});

test("admin inherits the shared request ceiling and unknown routes never consume a body", async () => {
  const http = new GraphsHttp({});
  const request = { method: "POST", url: "/graphs/api/not-an-action", [Symbol.asyncIterator]() { throw new Error("Unknown route consumed a body"); } };
  expect(await http.handle(request as never, {} as never)).toBe(false);
  const x = await setup(); const a = x.service.create(x.caller, { operationKey: "create", title: "A" });
  const response = await x.get(`/graphs/admin/${a.graphId}/force-unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1024 * 1024 + 1) });
  expect(response.status).toBe(400); expect(x.service.read(a.graphId).lock?.lockId).toBe(a.lockId);
});

test("parallel HTTP lock requests from two real core identities grant exactly one writer", async () => {
  const x = await setup();
  x.state.createLane({ address: "fixture/other", project: "fixture", roleDescription: "Other", now: 1 });
  x.state.createBinding({ id: "binding-other", laneAddress: "fixture/other", backend: "codex", conversationId: "other-thread", generation: 1, startup: {}, now: 2 });
  const other = { backend: "codex", conversationId: "other-thread", requestKey: "other-rpc" } as const;
  const a = x.service.create(x.caller, { operationKey: "create", title: "A" });
  x.service.lock(x.caller, { graphId: a.graphId, lockId: a.lockId!, operationKey: "release", action: "release" });
  const args = { graphId: a.graphId, action: "acquire", operationKey: "race" };
  const results = await Promise.allSettled([x.client.call("lane_graph_lock", args, x.caller), x.client.call("lane_graph_lock", args, other)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ code: "GRAPH_LOCKED" });
});

test("real core rotation continues a stable lane lock but address reuse does not inherit it", async () => {
  const x = await setup(); const a = x.service.create(x.caller, { operationKey: "create", title: "A" });
  expect(x.state.deactivateBinding("binding-owner", 1, x.now())).toBe(true);
  x.state.createBinding({ id: "binding-rotated", laneAddress: x.lane.address, backend: "codex", conversationId: "rotated-thread", generation: 2, startup: {}, now: x.now() });
  const rotated = { backend: "codex", conversationId: "rotated-thread", requestKey: "rotated" } as const;
  expect(() => x.service.readForLane(x.caller, { graphId: a.graphId })).toThrow();
  expect(x.service.lock(rotated, { graphId: a.graphId, action: "acquire", operationKey: "resume" }).lockId).toBe(a.lockId);
  const replacement = x.archiveAndReplace();
  x.state.createBinding({ id: "binding-replacement", laneAddress: replacement.address, backend: "codex", conversationId: "replacement-thread", generation: 1, startup: {}, now: x.now() });
  const reused = { backend: "codex", conversationId: "replacement-thread", requestKey: "replacement" } as const;
  expect(x.service.readForLane(reused, { graphId: a.graphId }).lock?.laneId).toBe(x.lane.id);
  expect(() => x.service.lock(reused, { graphId: a.graphId, action: "acquire", operationKey: "new-owner" })).toThrow(/GRAPH_LOCKED/);
  expect(replacement.id).not.toBe(x.lane.id);
});
