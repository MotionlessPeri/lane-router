import { afterEach, expect, test } from "vitest";
import { bindBuiltinTools } from "../../../src/application/builtin-tools.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

const fixtures: ReturnType<typeof setupIssues>[] = [];
afterEach(() => { fixtures.splice(0).forEach(x => x.dispose()); });
const setup = () => { const x = setupIssues(); fixtures.push(x); return { ...x, tools: bindBuiltinTools({ call: async () => "base" } as never, x.service) }; };

test("four tools preserve own-lane rounds, processing facts and explicit TUI closure", async () => {
  const x = setup();
  const issue = await x.tools.call("lane_issue_publish", { operationKey: "publish", title: "Choose", kind: "question", body: "Which?" }, x.caller) as { issueId: string; questionId: string };
  const reply = x.service.reply({ operationKey: "user", issueId: issue.issueId, questionId: issue.questionId, body: "A" });
  const answer = await x.tools.call("lane_issue_append", { operationKey: "answer", issueId: issue.issueId, questionId: issue.questionId, kind: "answer", body: "A done" }, x.caller) as { entryId: string };
  await x.tools.call("lane_issue_update", { action: "resolve_question", operationKey: "resolve", issueId: issue.issueId, questionId: issue.questionId, status: "answered", answerEntryId: answer.entryId }, x.caller);
  const receipt = { action: "record_processed", operationKey: "processed", issueId: issue.issueId, deliveryId: reply.deliveryId };
  const processed = await x.tools.call("lane_issue_update", receipt, x.caller);
  expect(await x.tools.call("lane_issue_update", receipt, x.caller)).toEqual(processed);
  const detail = await x.tools.call("lane_issue_read", { issueId: issue.issueId }, x.caller) as any;
  expect(detail.thread.status).toBe("open");
  expect(detail.deliveries[0].processedAt).not.toBeNull();
  expect(detail.questions[0].status).toBe("answered");
  expect(await x.tools.call("lane_issue_read", { issueId: issue.issueId, limit: 200 }, x.caller)).toEqual(detail);
  expect((await x.tools.call("lane_issue_read", { limit: 200 }, x.caller) as any).items).toHaveLength(1);
  expect((await x.tools.call("lane_issue_read", {}, x.other) as any).items).toEqual([]);
  for (const [name, input] of [
    ["lane_issue_read", { issueId: issue.issueId }],
    ["lane_issue_append", { operationKey: "other", issueId: issue.issueId, kind: "question", body: "Other?" }],
    ["lane_issue_update", { action: "record_tui_close", operationKey: "other-close", issueId: issue.issueId, body: "End it" }],
    ["lane_issue_update", receipt],
  ] as const) await expect(x.tools.call(name, input, x.other)).rejects.toThrow();
  await expect(x.tools.call("lane_issue_update", { operationKey: "close", issueId: issue.issueId, status: "closed" }, x.caller)).rejects.toThrow();
  await x.tools.call("lane_issue_update", { action: "record_tui_close", operationKey: "close", issueId: issue.issueId, body: "We are done here." }, x.caller);
  const closed = x.service.detail(issue.issueId);
  expect(closed.thread.status).toBe("closed");
  expect(closed.entries.at(-1)).toMatchObject({ body: "We are done here.", source: "agent_reported_tui_user" });
});

test("strict tools reject identity and unsupported publishing categories", async () => {
  const x = setup();
  const publish = { operationKey: "p", title: "Result", kind: "answer", body: "Done", originalQuestion: "What?" };
  for (const field of ["owner", "ownerLaneId", "backend", "generation", "confirmed"]) {
    for (const [name, input] of [
      ["lane_issue_publish", publish], ["lane_issue_read", {}],
      ["lane_issue_append", { operationKey: "a", issueId: "id", kind: "tui_user", body: "A" }],
      ["lane_issue_update", { action: "record_tui_close", operationKey: "c", issueId: "id", body: "End" }],
    ] as const) await expect(x.tools.call(name, { ...input, [field]: "spoof" }, x.caller)).rejects.toThrow();
  }
  await expect(x.tools.call("lane_issue_publish", { ...publish, originalQuestion: undefined }, x.caller)).rejects.toThrow();
  await expect(x.tools.call("lane_issue_publish", { ...publish, kind: "progress" }, x.caller)).rejects.toThrow();
  expect(x.service.list({ filter: "all" }).items).toEqual([]);
});
