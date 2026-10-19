import { afterEach, expect, test } from "vitest";
import { ISSUE_TOOLS } from "../../../src/modules/issues/tool-schema.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

const fixtures: ReturnType<typeof setupIssues>[] = [];
afterEach(() => { fixtures.splice(0).forEach((x) => x.dispose()); });
const setup = () => { const x = setupIssues(); fixtures.push(x); return x; };

const events = (x: ReturnType<typeof setupIssues>, issueId: string) => x.service.detail(issueId).entries.filter((entry) => entry.kind === "event");

// The ball is with the lane once the user has replied to a question; the lane's answer to that
// question is the end of it, and used to need a second call that was often missed.
test("an answer carrying the question it answers marks a question waiting on the lane answered, once", () => {
  const x = setup();
  const asked = publishQuestion(x);
  x.service.reply({ operationKey: "user-reply", issueId: asked.issueId, questionId: asked.questionId, body: "A" });
  expect(x.service.detail(asked.issueId).questions[0]).toMatchObject({ status: "waiting_lane" });

  const input = { operationKey: "answer", issueId: asked.issueId, questionId: asked.questionId!, kind: "answer" as const, body: "A is done." };
  const answer = x.service.append(x.caller, input);
  const detail = x.service.detail(asked.issueId);
  expect(detail.questions[0]).toMatchObject({ id: asked.questionId, status: "answered", answerEntryId: answer.entryId, reason: null });
  // The same completion fact resolve_question leaves behind, so history reads the same either way.
  expect(events(x, asked.issueId)).toEqual([expect.objectContaining({
    body: `问题 ${asked.questionId} 已回答（answered）。\n答复 entry ID: ${answer.entryId}`,
    author: "lane", source: "agent", relatedEntryId: asked.entryId,
  })]);

  expect(x.service.append(x.caller, input)).toEqual(answer);
  expect(x.service.detail(asked.issueId)).toEqual(detail);
});

test("an answer leaves a question that is not waiting on the lane, and an answer naming no question, as they were", () => {
  const x = setup();
  const waitingUser = publishQuestion(x, "Still with the user?", "waiting-user");
  const answered = publishQuestion(x, "Already answered?", "answered");
  x.service.reply({ operationKey: "answered-reply", issueId: answered.issueId, questionId: answered.questionId, body: "Yes" });
  const prior = x.service.append(x.caller, { operationKey: "answered-prior", issueId: answered.issueId, kind: "answer", body: "Answer." });
  x.service.updateQuestion(x.caller, { operationKey: "answered-resolve", issueId: answered.issueId, questionId: answered.questionId!, status: "answered", answerEntryId: prior.entryId });
  const notNeeded = publishQuestion(x, "No longer needed?", "not-needed");
  x.service.updateQuestion(x.caller, { operationKey: "not-needed-resolve", issueId: notNeeded.issueId, questionId: notNeeded.questionId!, status: "not_needed", reason: "Superseded." });
  const unnamed = publishQuestion(x, "Answered without naming it?", "unnamed");
  x.service.reply({ operationKey: "unnamed-reply", issueId: unnamed.issueId, questionId: unnamed.questionId, body: "Please" });

  for (const [label, asked, questionId] of [
    ["waiting_user", waitingUser, waitingUser.questionId], ["answered", answered, answered.questionId],
    ["not_needed", notNeeded, notNeeded.questionId], ["no questionId", unnamed, undefined],
  ] as const) {
    const before = x.service.detail(asked.issueId);
    x.service.append(x.caller, { operationKey: `late-${label}`, issueId: asked.issueId, kind: "answer", body: "Another answer.", ...(questionId ? { questionId } : {}) });
    const after = x.service.detail(asked.issueId);
    expect(after.questions, label).toEqual(before.questions);
    expect(events(x, asked.issueId), label).toEqual(before.entries.filter((entry) => entry.kind === "event"));
  }
});

test("an explanation still hands the question back to the user, and TUI input still hands it to the lane", () => {
  const x = setup();
  const asked = publishQuestion(x);
  x.service.reply({ operationKey: "user-reply", issueId: asked.issueId, questionId: asked.questionId, body: "Why?" });
  x.service.append(x.caller, { operationKey: "explain", issueId: asked.issueId, questionId: asked.questionId, kind: "explanation", body: "Because." });
  expect(x.service.detail(asked.issueId).questions[0]).toMatchObject({ status: "waiting_user", answerEntryId: null });
  x.service.append(x.caller, { operationKey: "tui", issueId: asked.issueId, questionId: asked.questionId, kind: "tui_user", body: "用户在 TUI 里的原话" });
  expect(x.service.detail(asked.issueId).questions[0]).toMatchObject({ status: "waiting_lane", answerEntryId: null });
  expect(events(x, asked.issueId)).toEqual([]);
});

test("a page reply's delivery says what to do next with this reply's question, and the append tool says an answer resolves it", () => {
  const x = setup();
  const asked = publishQuestion(x);
  const reply = x.service.reply({ operationKey: "user-reply", issueId: asked.issueId, questionId: asked.questionId, body: "A" });
  const body = x.service.detail(asked.issueId).deliveries[0]!.body;
  expect(body).toContain(`lane_issue_append（kind: answer，questionId: ${reply.questionId}）`);
  expect(body).toContain("record_processed");
  expect(body).toContain(`delivery ID: ${reply.deliveryId}`);
  expect(body.indexOf("下一步")).toBeGreaterThan(body.indexOf("查询完整议题"));
  expect(body.indexOf("lane_ack")).toBeGreaterThan(body.indexOf("record_processed"));
  const append = ISSUE_TOOLS.find((tool) => tool.name === "lane_issue_append")!;
  expect(append.description).toContain("An answer with questionId marks a question that is waiting on your lane as answered");
  expect(append.description).toContain("leave questionId out");
});
