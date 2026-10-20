import { afterEach, expect, test } from "vitest";

import { bindBuiltinTools } from "../../../src/application/builtin-tools.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

// Spec 2026-10-20-issue-lane-close-and-default-publish.md, acceptance 1–4 and 6.
const fixtures: ReturnType<typeof setupIssues>[] = [];
afterEach(() => { for (const x of fixtures.splice(0)) x.dispose(); });
const setup = () => { const x = setupIssues(); fixtures.push(x); return x; };
type Issues = ReturnType<typeof setup>;

/** An answer to a question the user asked in the TUI: nothing in it waits on anyone. */
const settled = (x: Issues, operationKey = "answer") => x.service.publish(x.caller, { operationKey, title: "构建", kind: "answer", originalQuestion: "构建为什么慢？", body: "缓存失效了，已修好。" });
const close = (x: Issues, issueId: string, reason = "缓存已修好，用户确认过。", operationKey = "lane-close") =>
  x.service.closeByLane(x.caller, { operationKey, issueId, reason });
/** Everything a refused write must leave as it was. */
const snapshot = (x: Issues, issueId: string) => ({ detail: x.service.detail(issueId), list: x.service.list({ filter: "all" }), attention: x.service.list() });

test("1: a lane ends an issue whose questions are all settled; it is ended by the lane, with the reason in its history", () => {
  const x = setup();
  const issue = settled(x);
  const before = x.service.detail(issue.issueId);
  const result = close(x, issue.issueId);
  const after = x.service.detail(issue.issueId);
  expect(after.thread).toMatchObject({ status: "closed", closedBy: "lane", closedAt: after.entries.at(-1)!.createdAt });
  expect(after.entries).toHaveLength(before.entries.length + 1);
  expect(after.entries.at(-1)).toMatchObject({ id: result.entryId, kind: "event", author: "lane", source: "agent",
    body: "lane 结束：缓存已修好，用户确认过。", recordedByBindingId: "binding:lane-one", recordedByGeneration: 1 });
  // The same key and content again is the same close, not a second one.
  expect(close(x, issue.issueId)).toEqual(result);
  expect(x.service.detail(issue.issueId)).toEqual(after);
});

test("1: a question the lane marked not needed is settled too", () => {
  const x = setup();
  const issue = publishQuestion(x);
  x.service.updateQuestion(x.caller, { operationKey: "drop", issueId: issue.issueId, questionId: issue.questionId!, status: "not_needed", reason: "改做法了" });
  close(x, issue.issueId);
  expect(x.service.detail(issue.issueId).thread).toMatchObject({ status: "closed", closedBy: "lane" });
});

test("2: a lane cannot end an issue with a question waiting on either side, someone else's, an ended one, or without a reason; nothing is written", () => {
  const x = setup();
  const waitingUser = publishQuestion(x, "选 A 还是 B？", "waiting-user");
  const waitingLane = publishQuestion(x, "要不要提交？", "waiting-lane");
  x.service.reply({ operationKey: "reply", issueId: waitingLane.issueId, questionId: waitingLane.questionId, body: "先说说风险" });
  const foreign = x.service.publish(x.other, { operationKey: "foreign", title: "别人的", kind: "answer", originalQuestion: "?", body: "!" });
  const ended = settled(x, "ended");
  close(x, ended.issueId, "做完了", "first-close");
  // Closable but for its reason, so the reason is all that is refused.
  const closable = settled(x, "closable");
  for (const [label, issueId, reason, code] of [
    ["waiting_user", waitingUser.issueId, "做完了", "QUESTIONS_WAITING"],
    ["waiting_lane", waitingLane.issueId, "做完了", "QUESTIONS_WAITING"],
    ["another lane's", foreign.issueId, "做完了", "ISSUE_NOT_FOUND"],
    ["already ended", ended.issueId, "再结束一次", "ISSUE_CLOSED"],
    ["blank reason", closable.issueId, "  ", "INVALID_INPUT"],
  ] as const) {
    const before = snapshot(x, issueId);
    expect(() => close(x, issueId, reason, `refused-${label}`), label).toThrowError(expect.objectContaining({ code }));
    expect(snapshot(x, issueId), label).toEqual(before);
    expect(x.store.operation("lane:lane-one", "close", `refused-${label}`), label).toBeNull();
  }
  // The refusal says how to get past it.
  expect(() => close(x, waitingLane.issueId)).toThrowError(/questionId|not_needed/u);
});

test("3: a user's reply reopens an issue whichever side ended it; the lane can end it again, but cannot add to it while it is ended", () => {
  for (const ender of ["lane", "user"] as const) {
    const x = setup();
    const issue = settled(x);
    if (ender === "lane") close(x, issue.issueId);
    else x.service.close({ operationKey: "page-close", issueId: issue.issueId, body: "用户在议题页面明确确认结束讨论。" });
    expect(() => x.service.append(x.caller, { operationKey: "late", issueId: issue.issueId, kind: "answer", body: "补充" }), ender)
      .toThrowError(expect.objectContaining({ code: "ISSUE_CLOSED" }));
    const before = x.service.detail(issue.issueId);

    const reply = x.service.reply({ operationKey: "reopen", issueId: issue.issueId, body: "还有一处要看" });
    const after = x.service.detail(issue.issueId);
    expect(after.thread, ender).toMatchObject({ status: "open", closedAt: null, closedBy: null });
    expect(after.entries.slice(before.entries.length).map(({ kind, author, source, body }) => ({ kind, author, source, body })), ender).toEqual([
      { kind: "event", author: "user", source: "user_page", body: "用户回复，议题重新打开" },
      { kind: "reply", author: "user", source: "user_page", body: "还有一处要看" },
    ]);
    const delivery = after.deliveries.find(item => item.id === reply.deliveryId)!;
    expect(delivery.body, ender).toMatch(new RegExp(`^这条问答原先已结束（由${ender === "lane" ? " lane " : "用户"}结束），用户的回复让它重新打开了。`, "u"));
    // A replay is the same reply, not a second reopening.
    expect(x.service.reply({ operationKey: "reopen", issueId: issue.issueId, body: "还有一处要看" }), ender).toEqual(reply);
    expect(x.service.detail(issue.issueId), ender).toEqual(after);

    // The reply waits on the lane; once answered, the lane may end the issue again.
    x.service.append(x.caller, { operationKey: "answer-again", issueId: issue.issueId, kind: "answer", questionId: reply.questionId, body: "看过了，没问题。" });
    close(x, issue.issueId, "第二处也看过了", "close-again");
    expect(x.service.detail(issue.issueId).thread, ender).toMatchObject({ status: "closed", closedBy: "lane" });
    expect(() => x.service.updateQuestion(x.caller, { operationKey: "late-resolve", issueId: issue.issueId, questionId: reply.questionId!, status: "not_needed", reason: "晚了" }), ender)
      .toThrowError(expect.objectContaining({ code: "ISSUE_CLOSED" }));
  }
});

test("4: who ended an issue is saved and returned by the list, the detail and lane_issue_read", async () => {
  const x = setup();
  const tools = bindBuiltinTools({ call: async () => "base" } as never, x.service);
  const byPage = settled(x), byTui = publishQuestion(x, "TUI 里结束", "tui"), byLane = publishQuestion(x, "lane 结束", "lane");
  x.service.close({ operationKey: "page", issueId: byPage.issueId, body: "用户在议题页面明确确认结束讨论。" });
  x.service.recordTuiClose(x.caller, { operationKey: "tui", issueId: byTui.issueId, body: "用户原话：这个结束吧" });
  x.service.updateQuestion(x.caller, { operationKey: "drop", issueId: byLane.issueId, questionId: byLane.questionId!, status: "not_needed", reason: "不用了" });
  close(x, byLane.issueId);
  const expected = { [byPage.issueId]: "user", [byTui.issueId]: "user", [byLane.issueId]: "lane" };
  for (const [issueId, closedBy] of Object.entries(expected)) {
    expect(x.service.detail(issueId).thread.closedBy, issueId).toBe(closedBy);
    expect(x.service.list({ filter: "closed" }).items.find(item => item.id === issueId)?.closedBy, issueId).toBe(closedBy);
    expect((await tools.call("lane_issue_read", { issueId }, x.caller) as any).thread.closedBy, issueId).toBe(closedBy);
    expect((await tools.call("lane_issue_read", { filter: "closed" }, x.caller) as any).items.find((item: any) => item.id === issueId)?.closedBy, issueId).toBe(closedBy);
  }
  expect(x.service.list({ filter: "open" }).items).toEqual([]);
  const open = settled(x, "still-open");
  expect(x.service.detail(open.issueId).thread.closedBy).toBeNull();
});

test("6: an issue the lane ended stays in 待我处理 while its lane content is unread; one the user ended does not", () => {
  const x = setup();
  const lane = settled(x);
  close(x, lane.issueId);
  expect(x.service.list().items.map(item => [item.id, item.attentionReasons])).toEqual([[lane.issueId, ["unread_lane_content"]]]);
  expect(x.service.list({ filter: "closed" }).items[0]?.attentionReasons).toEqual(["unread_lane_content"]);

  const user = settled(x, "user-ends");
  x.service.close({ operationKey: "page", issueId: user.issueId, body: "用户在议题页面明确确认结束讨论。" });
  expect(x.service.list().items.map(item => item.id)).toEqual([lane.issueId]);

  // Reading to the end, the lane's closing record included, takes it out.
  const { thread } = x.service.detail(lane.issueId);
  x.service.markRead({ operationKey: "read", issueId: lane.issueId, throughSeq: thread.nextSeq - 1 });
  expect(x.service.list().items).toEqual([]);
  expect(x.service.list({ filter: "closed" }).items.map(item => item.attentionReasons)).toEqual([[], []]);
});
