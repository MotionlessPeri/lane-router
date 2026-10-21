import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { setupIssueRouter } from "../../fixtures/issues/router.js";
import { KnowledgeService, openKnowledgeStore } from "../../../src/modules/knowledge/index.js";
import { runKnowledgeCli } from "../../../src/modules/knowledge/cli.js";
import { bindBuiltinTools, productToolCatalog } from "../../../src/application/builtin-tools.js";
import { LocalRouterClient } from "../../../src/process/local-client.js";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { launchLane } from "../../../src/process/lane-launcher.js";
import { ToolService } from "../../../src/tools/tool-service.js";

const closes: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function setup() {
  const x = setupIssueRouter(); closes.push(() => x.dispose());
  const store = openKnowledgeStore(join(x.root, "knowledge.sqlite")); closes.push(() => store.close());
  const service = new KnowledgeService({ store, lanes: x.core }); let origin = "http://127.0.0.1";
  const tools = new ToolService(x.core);
  const server = new LocalRouterServer({ tools, applicationTools: bindBuiltinTools(tools, x.service, productToolCatalog, undefined, () => origin, service), instanceId: randomUUID() });
  origin = (await server.start()).url; closes.push(() => server.close());
  const client = new LocalRouterClient(async () => origin);
  let sequence = 0;
  const cli = async (verb: string, input: unknown) => {
    const path = join(x.root, `kb-${++sequence}.json`); writeFileSync(path, JSON.stringify(input)); let output = "";
    await runKnowledgeCli([verb, "--json-file", path], { client, env: { CODEX_THREAD_ID: x.caller.conversationId }, cwd: x.root, write: text => { output += text; } });
    return JSON.parse(output);
  };
  return { ...x, origin, cli, tool: (name: string, input: Record<string, unknown>) => client.call(name, input, x.caller) as Promise<any> };
}
const page = { title: "lane_send 群发", summary: "一次发给多条 lane", body: "Router 拒收 cc 字段。" };

test("14. an old Codex conversation checks and commits with --json-file and gets what the tools return", async () => {
  const x = await setup();
  const checked = await x.cli("record", { step: "check", ...page, terms: ["cc"] });
  expect(checked).toMatchObject({ checkId: expect.any(String), candidates: [], index: [] });
  const commit = { step: "commit", checkId: checked.checkId, operationKey: "cli-create", decision: { kind: "create", ...page } };
  const created = await x.cli("record", commit);
  expect(created).toMatchObject({ action: "create", version: 1, replayed: false, viewUrl: `${x.origin}/knowledge/${created.pageId}` });
  expect(await x.tool("lane_kb_record", commit)).toEqual({ ...created, replayed: true });
  for (const input of [{}, { query: "拒收" }, { pageId: created.pageId }]) expect(await x.cli("search", input), JSON.stringify(input)).toEqual(await x.tool("lane_kb_search", input));
  const second = await x.tool("lane_kb_record", { step: "check", ...page });
  expect(second.candidates).toEqual([expect.objectContaining({ pageId: created.pageId })]);
});

test("the CLI needs the current Codex thread, one verb and one JSON file, and checks the input before calling", async () => {
  const client = { call: vi.fn() }; const readJsonFile = () => ({ query: "q" });
  await expect(runKnowledgeCli(["search", "--json-file", "input"], { client, env: {}, readJsonFile })).rejects.toThrow(/CODEX_THREAD_ID/);
  await expect(runKnowledgeCli(["search", "--json-file", "input", "--lane", "spoof"], { client, env: { CODEX_THREAD_ID: "t" }, readJsonFile })).rejects.toThrow(/Usage/);
  await expect(runKnowledgeCli(["delete", "--json-file", "input"], { client, env: { CODEX_THREAD_ID: "t" }, readJsonFile })).rejects.toThrow(/Usage/);
  await expect(runKnowledgeCli(["record", "--json-file", "input"], { client, env: { CODEX_THREAD_ID: "t" }, readJsonFile: () => ({ step: "check", title: "T" }) })).rejects.toThrow();
  expect(client.call).not.toHaveBeenCalled();
});

test("lane-router-lane kb routes to the knowledge CLI", async () => {
  const call = vi.fn(async () => ({ pages: [] })); let output = "";
  await launchLane(["kb", "search", "--json-file", "input"], { knowledgeClient: { call }, readKnowledgeJsonFile: () => ({}), env: { CODEX_THREAD_ID: "thread" }, cwd: "C:/work", write: text => { output += text; } });
  expect(call).toHaveBeenCalledWith("lane_kb_search", {}, expect.objectContaining({ backend: "codex", conversationId: "thread", cwd: "C:/work" }));
  expect(JSON.parse(output)).toEqual({ pages: [] });
});
