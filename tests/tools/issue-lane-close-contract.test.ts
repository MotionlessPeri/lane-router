import { afterEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { bindBuiltinTools, communicationToolCatalog, productToolCatalog } from "../../src/application/builtin-tools.js";
import type { ToolCatalog } from "../../src/application/tool-catalog.js";
import { CodexRuntime } from "../../src/adapters/codex/codex-runtime.js";
import { createLaneMcpServer } from "../../src/mcp/lane-mcp-server.js";
import { ISSUE_INSTRUCTIONS } from "../../src/modules/issues/tool-schema.js";
import { LANE_ROUTER_INSTRUCTIONS } from "../../src/tools/tool-contract.js";
import { setupIssues } from "../fixtures/issues/setup.js";

// Spec 2026-10-20-issue-lane-close-and-default-publish.md, acceptance 7 (the close action as
// published) and 8 (the issues instructions reach both backends, and only with the issue tools).
const closers: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

test("7: lane_issue_update publishes close with a reason, for MCP and for Codex, and no longer says only the user can end an issue", () => {
  for (const target of [undefined, "draft-7"] as const) {
    const update = productToolCatalog.jsonTools(target).find(tool => tool.name === "lane_issue_update")!;
    const properties = update.inputSchema.properties as Record<string, { enum?: unknown[] }>;
    expect(properties.action?.enum, target).toContain("close");
    expect(Object.keys(properties), target).toContain("reason");
    expect(update.description, target).toContain('action="close": operationKey, issueId, reason');
    expect(update.description, target).not.toContain("Only the user can end an issue");
  }
  expect(() => productToolCatalog.parse("lane_issue_update", { action: "close", operationKey: "k", issueId: "i", reason: "done" })).not.toThrow();
  for (const refused of [{ action: "close", operationKey: "k", issueId: "i" }, { action: "close", operationKey: "k", issueId: "i", reason: " " },
    { action: "close", operationKey: "k", issueId: "i", reason: "done", body: "extra" }]) {
    expect(() => productToolCatalog.parse("lane_issue_update", refused), JSON.stringify(refused)).toThrow();
  }
});

test("7: the close action reaches the service as the lane ending its issue", async () => {
  const x = setupIssues(); closers.push(() => x.dispose());
  const tools = bindBuiltinTools({ call: async () => "base" } as never, x.service);
  const issue = x.service.publish(x.caller, { operationKey: "p", title: "构建", kind: "answer", originalQuestion: "?", body: "修好了" });
  await tools.call("lane_issue_update", { action: "close", operationKey: "close", issueId: issue.issueId, reason: "修好了，用户确认过" }, x.caller);
  expect(x.service.detail(issue.issueId).thread).toMatchObject({ status: "closed", closedBy: "lane" });
});

async function mcpInstructions(catalog?: ToolCatalog) {
  const server = createLaneMcpServer({ router: { call: async () => ({}) }, conversationId: "session", ...(catalog ? { catalog } : {}) });
  const client = new Client({ name: "instructions-reader", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return client.getInstructions();
}
const codexInstructions = (catalog?: ToolCatalog) => new CodexRuntime({
  core: { callTool: async () => ({}), ownsThread: async () => false, event: () => undefined },
  ...(catalog ? { catalog } : {}),
  process: { client: { onNotification: () => () => {} }, start: () => { throw new Error("fixture process must not start"); } } as never,
}).decorateThreadStart({}).developerInstructions;

test("8: a catalog with the issue tools tells both backends the same issues instructions; one with only the communication tools does not", async () => {
  const product = await mcpInstructions(productToolCatalog);
  expect(product).toBe(`${LANE_ROUTER_INSTRUCTIONS}\n\n${ISSUE_INSTRUCTIONS}`);
  expect(codexInstructions(productToolCatalog)).toBe(product);
  for (const catalog of [undefined, communicationToolCatalog]) {
    expect(await mcpInstructions(catalog)).toBe(LANE_ROUTER_INSTRUCTIONS);
    expect(codexInstructions(catalog)).toBe(LANE_ROUTER_INSTRUCTIONS);
  }
});

test("8: the issues instructions say when to put a question in an issue, what not to publish, and how issues end", () => {
  for (const point of ["lane_issue_publish", "lane_issue_append", "kind: question", "Do not publish progress", "lane_send", "tui_user", "action close", "user:issues"]) {
    expect(ISSUE_INSTRUCTIONS, point).toContain(point);
  }
});
