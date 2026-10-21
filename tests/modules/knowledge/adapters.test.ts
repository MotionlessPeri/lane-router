import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { setupIssueRouter } from "../../fixtures/issues/router.js";
import { KnowledgeService, openKnowledgeStore } from "../../../src/modules/knowledge/index.js";
import { knowledgeToolArgsSchemas } from "../../../src/modules/knowledge/tool-schema.js";
import { bindBuiltinTools, productToolCatalog } from "../../../src/application/builtin-tools.js";
import { codexDynamicTools } from "../../../src/adapters/codex/dynamic-tools.js";
import { LocalRouterClient } from "../../../src/process/local-client.js";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { ToolService } from "../../../src/tools/tool-service.js";

const closes: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function setupKnowledgeRouter(available = true) {
  const x = setupIssueRouter(); closes.push(() => x.dispose());
  const store = openKnowledgeStore(join(x.root, "knowledge.sqlite")); closes.push(() => store.close());
  const service = new KnowledgeService({ store, lanes: x.core }); const tools = new ToolService(x.core);
  let origin = "http://127.0.0.1";
  const applicationTools = bindBuiltinTools(tools, x.service, productToolCatalog, undefined, () => origin, available ? service : undefined);
  const server = new LocalRouterServer({ tools, applicationTools, instanceId: randomUUID() });
  origin = (await server.start()).url; closes.push(() => server.close());
  const client = new LocalRouterClient(async () => origin);
  return { ...x, service, origin, client, call: (name: string, input: Record<string, unknown>) => client.call(name, input, x.caller) as Promise<any> };
}

test("both knowledge tools are published as flat roots that list their argument combinations", () => {
  for (const tools of [productToolCatalog.jsonTools(), codexDynamicTools(productToolCatalog)]) {
    const named = new Map(tools.map(tool => [tool.name, tool]));
    const search = named.get("lane_kb_search")!; const record = named.get("lane_kb_record")!;
    for (const tool of [search, record]) expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(search.description.split("Argument combinations (use exactly one):\n")[1]!.split("\n"))
      .toEqual(["1. query; optional: terms, includeSuperseded, limit", "2. pageId; optional: version", "3. optional: afterId, limit"]);
    expect((record.inputSchema as any).properties.step).toEqual({ type: "string", enum: ["check", "commit"] });
    expect((record.inputSchema as any).required).toEqual(["step"]);
  }
  expect(() => knowledgeToolArgsSchemas.lane_kb_record.parse({ step: "check", title: "T", summary: "S", body: "B", laneId: "spoof" })).toThrow();
  expect(() => knowledgeToolArgsSchemas.lane_kb_search.parse({ query: "q", laneId: "spoof" })).toThrow();
});

test("a lane checks, commits and searches through the real Router RPC, and gets viewing URLs back", async () => {
  const x = await setupKnowledgeRouter();
  const page = { title: "lane_send 群发", summary: "一次发给多条 lane", body: "Router 拒收 cc 字段。" };
  const checked = await x.call("lane_kb_record", { step: "check", ...page });
  expect(checked).toMatchObject({ checkId: expect.any(String), candidates: [], index: [] });
  const created = await x.call("lane_kb_record", { step: "commit", checkId: checked.checkId, operationKey: "create", decision: { kind: "create", ...page } });
  expect(created).toMatchObject({ action: "create", version: 1, viewUrl: `${x.origin}/knowledge/${created.pageId}` });
  const found = await x.call("lane_kb_search", { query: "拒收" });
  expect(found).toMatchObject({ hits: [{ pageId: created.pageId, viewUrl: `${x.origin}/knowledge/${created.pageId}` }], viewUrl: `${x.origin}/knowledge?q=${encodeURIComponent("拒收")}` });
  expect(await x.call("lane_kb_search", {})).toMatchObject({ pages: [{ pageId: created.pageId }], viewUrl: `${x.origin}/knowledge` });
  expect(await x.call("lane_kb_search", { pageId: created.pageId })).toMatchObject({ ...page, version: 1, viewUrl: created.viewUrl });
  await expect(x.call("lane_kb_record", { step: "commit", operationKey: "no-check", decision: { kind: "create", title: "T", summary: "S", body: "B" } }))
    .rejects.toMatchObject({ code: "CHECK_REQUIRED" });
  await expect(x.call("lane_kb_search", { pageId: "missing" })).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
});

test("without the knowledge module the tools fail as KB_UNAVAILABLE and the other tools still answer", async () => {
  const x = await setupKnowledgeRouter(false);
  await expect(x.call("lane_kb_search", {})).rejects.toMatchObject({ code: "KB_UNAVAILABLE" });
  await expect(x.call("lane_kb_record", { step: "check", title: "T", summary: "S", body: "B" })).rejects.toMatchObject({ code: "KB_UNAVAILABLE" });
  await expect(x.call("lane_issue_read", {})).resolves.toBeDefined();
  await expect(x.call("lane_directory", { project: "fixture" })).resolves.toEqual(expect.any(Array));
});
