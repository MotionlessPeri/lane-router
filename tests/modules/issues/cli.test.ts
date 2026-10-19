import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { launchLane } from "../../../src/process/lane-launcher.js";
import { LocalRouterClient } from "../../../src/process/local-client.js";
import { LocalRouterServer } from "../../../src/process/local-server.js";
import { bindBuiltinTools } from "../../../src/application/builtin-tools.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const x = setupIssues(); cleanup.push(() => x.dispose());
  const server = new LocalRouterServer({ tools: {} as never,
    applicationTools: bindBuiltinTools({} as never, x.service),
    instanceId: "cli-fixture" });
  const { url } = await server.start(); cleanup.push(() => server.close());
  const client = new LocalRouterClient(async () => url);
  const calls: unknown[][] = [];
  const issueClient = { call: async (...args: Parameters<LocalRouterClient["call"]>) => { calls.push(args); return client.call(...args); } };
  const output: string[] = [];
  const deps = { issueClient, env: { CODEX_THREAD_ID: x.caller.conversationId }, cwd: "C:/fixture", write: (s: string) => output.push(s) };
  const invoke = (verb: string, input: unknown) => launchLane(["issue", verb, "--json-file", "fixture.json"], { ...deps, readIssueJsonFile: () => input });
  return { ...x, x, deps, invoke, calls, output };
}

test("issue CLI uses current Codex identity and loopback tools with stable business keys", async () => {
  const x = await fixture();
  const input = { operationKey: "publish", title: "Choose", kind: "question", body: "Which?" };
  expect(await x.invoke("publish", input)).toBe(0);
  const first = JSON.parse(x.output[0]!);
  expect(await x.invoke("publish", input)).toBe(0);
  expect(JSON.parse(x.output[1]!)).toEqual(first);
  expect(x.x.service.list({ filter: "all" }).items).toHaveLength(1);
  expect(x.calls[0]).toEqual(["lane_issue_publish", input, { backend: "codex", conversationId: x.caller.conversationId, cwd: "C:/fixture", requestKey: expect.any(String) }]);
  expect((x.calls[0]![2] as any).requestKey).not.toBe((x.calls[1]![2] as any).requestKey);
  await x.invoke("append", { operationKey: "append", issueId: first.issueId, kind: "answer", body: "A." });
  await x.invoke("update", { operationKey: "update", issueId: first.issueId, action: "resolve_question", questionId: first.questionId, status: "not_needed", reason: "Already decided" });
  await x.invoke("read", { issueId: first.issueId, afterSeq: 1, limit: 1 });
  expect(JSON.parse(x.output.at(-1)!).entries[0].body).toBe("A.");
  await x.invoke("record-tui-close", { operationKey: "close", issueId: first.issueId, body: "用户原话：结束这个议题。" });
  expect(x.x.service.detail(first.issueId).entries.at(-1)).toMatchObject({ body: "用户原话：结束这个议题。", source: "agent_reported_tui_user" });
  expect(x.calls.at(-1)?.slice(0, 2)).toEqual(["lane_issue_update", { operationKey: "close", issueId: first.issueId, body: "用户原话：结束这个议题。", action: "record_tui_close" }]);
});

test("issue CLI refuses missing or unbound identity and never prints false success", async () => {
  const x = await fixture();
  const args = ["issue", "read", "--json-file", "fixture.json"];
  await expect(launchLane(args, { ...x.deps, env: {}, readIssueJsonFile: () => ({}) })).rejects.toThrow(/CODEX_THREAD_ID/);
  await expect(launchLane(args, { ...x.deps, env: { CODEX_THREAD_ID: "unbound" }, readIssueJsonFile: () => ({}) })).rejects.toMatchObject({ code: "NOT_ATTACHED" });
  expect(x.output).toEqual([]);
});

test("issue CLI rejects extra flags, identity JSON and overriding the dedicated close action", async () => {
  const call = vi.fn(); const readIssueJsonFile = vi.fn(() => ({}));
  for (const args of [[], ["read"], ["read", "--json-file", "x", "--backend", "claude"], ["read", "--json-file", "x", "--json-file", "y"], ["read", "--cwd", "x"], ["unknown", "--json-file", "x"]]) {
    await expect(launchLane(["issue", ...args], { issueClient: { call }, env: { CODEX_THREAD_ID: "t" }, readIssueJsonFile } as any)).rejects.toThrow();
  }
  expect(readIssueJsonFile).not.toHaveBeenCalled();
  const x = await fixture();
  for (const field of ["ownerLaneId", "backend", "generation", "confirmed", "cwd", "conversationId", "requestKey"]) {
    await expect(x.invoke("publish", { operationKey: "bad", title: "Q", kind: "question", body: "?", [field]: "spoof" })).rejects.toThrow();
  }
  await expect(x.invoke("record-tui-close", { operationKey: "bad", issueId: "i", body: "close", action: "record_processed" })).rejects.toThrow();
  expect(x.calls).toEqual([]);
  expect(x.output).toEqual([]);
});

test("issue CLI reads an ordinary JSON file and refuses missing or malformed input before RPC", async () => {
  const x = await fixture();
  // This checked-in JSON is written by the ordinary editor, not by a shell string.
  const file = new URL("../../fixtures/issues/cli-read.json", import.meta.url);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ filter: "all", limit: 2 });
  expect(await launchLane(["issue", "read", "--json-file", fileURLToPath(file)], x.deps)).toBe(0);
  expect(JSON.parse(x.output[0]!)).toEqual({ items: [], nextCursor: null });
  await expect(launchLane(["issue", "read", "--json-file", "missing-file.json"], x.deps)).rejects.toThrow();
  await expect(launchLane(["issue", "read", "--json-file", fileURLToPath(new URL("../../fixtures/issues/cli-malformed.txt", import.meta.url))], x.deps)).rejects.toThrow(SyntaxError);
  expect(x.calls).toHaveLength(1);
});

test("CLI preserves a business failure code and does not print or retry an uncertain result", async () => {
  const x = await fixture();
  const input = { operationKey: "original", title: "Q", kind: "question", body: "Which?" };
  await x.invoke("publish", input);
  await expect(x.invoke("publish", { ...input, body: "Changed" })).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  expect(x.output).toHaveLength(1);
  const call = vi.fn(async () => { throw new Error("request result is uncertain"); });
  await expect(launchLane(["issue", "read", "--json-file", "x"], { ...x.deps, issueClient: { call }, readIssueJsonFile: () => ({}) })).rejects.toThrow("uncertain");
  expect(call).toHaveBeenCalledOnce(); expect(x.output).toHaveLength(1);
});
