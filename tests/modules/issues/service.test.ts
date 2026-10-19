import { afterEach, describe, expect, it } from "vitest";

import { IssuesService } from "../../../src/modules/issues/index.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

const fixtures: ReturnType<typeof setupIssues>[] = [];
const setup = () => { const x = setupIssues(); fixtures.push(x); return x; };
afterEach(() => { for (const x of fixtures.splice(0)) x.dispose(); });

describe("issue conversation business", () => {
  it("publishes only answers with their original question or proactive questions", () => {
    const x = setup();
    const result = x.service.publish(x.caller, { operationKey: "answer", title: "Result", kind: "answer", originalQuestion: "What happened?", body: "All checked." });
    const detail = x.service.detail(result.issueId);
    expect(detail.entries.map((entry) => [entry.kind, entry.body])).toEqual([["question", "What happened?"], ["answer", "All checked."]]);
    expect(detail.questions).toEqual([expect.objectContaining({ status: "answered", answerEntryId: result.entryId, askedTo: "lane" })]);
    expect(detail.deliveries).toEqual([]);
    expect(() => x.service.publish(x.caller, { operationKey: "bad", title: "Bad", kind: "event", body: "no" } as never)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => x.service.publish(x.caller, { operationKey: "empty", title: "Bad", kind: "question", body: "  " })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => x.service.publish(x.caller, { operationKey: "missing", title: "Bad", kind: "answer", body: "answer" } as never)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    for (const field of ["ownerLaneId", "backend", "generation", "confirmed"]) {
      expect(() => x.service.publish(x.caller, { operationKey: `spoof-${field}`, title: "Bad", kind: "question", body: "Question?", [field]: "spoofed" } as never))
        .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });

  it("keeps selected rounds separate, TUI input local and explanation awaiting the user", () => {
    const x = setup();
    const first = publishQuestion(x);
    const second = x.service.append(x.caller, { operationKey: "q2", issueId: first.issueId, kind: "question", body: "And when?" });
    const reply = x.service.reply({ operationKey: "reply", issueId: first.issueId, questionId: first.questionId, body: "Use A." });
    let detail = x.service.detail(first.issueId);
    expect(detail.questions.map((q) => q.status)).toEqual(["waiting_lane", "waiting_user"]);
    expect(detail.entries.at(-1)).toMatchObject({ id: reply.entryId, relatedEntryId: first.entryId, author: "user" });
    x.service.append(x.caller, { operationKey: "explain", issueId: first.issueId, kind: "explanation", questionId: first.questionId, body: "A also needs a date; please decide." });
    expect(x.service.detail(first.issueId).questions[0]?.status).toBe("waiting_user");
    const tui = x.service.append(x.caller, { operationKey: "tui", issueId: first.issueId, kind: "tui_user", questionId: second.questionId, body: "Friday, from the terminal." });
    detail = x.service.detail(first.issueId);
    expect(detail.entries.at(-1)).toMatchObject({ id: tui.entryId, source: "agent_reported_tui_user", author: "user" });
    expect(detail.deliveries).toHaveLength(1);
    expect(detail.questions.map((q) => q.status)).toEqual(["waiting_user", "waiting_lane"]);
    x.service.updateQuestion(x.caller, { operationKey: "answered", issueId: first.issueId, questionId: second.questionId!, status: "answered", answerEntryId: tui.entryId });
    x.service.updateQuestion(x.caller, { operationKey: "skip", issueId: first.issueId, questionId: first.questionId!, status: "not_needed", reason: "Superseded by the selected date." });
    expect(x.service.detail(first.issueId).questions).toEqual([
      expect.objectContaining({ status: "not_needed", reason: "Superseded by the selected date." }),
      expect.objectContaining({ status: "answered", answerEntryId: tui.entryId }),
    ]);
  });

  it("computes waiting and unread independently and reads only actually displayed sequences", () => {
    const x = setup();
    const result = publishQuestion(x);
    expect(x.service.list().items[0]?.attentionReasons).toEqual(["waiting_user", "unread_lane_content"]);
    expect(x.service.detail(result.issueId).thread.readSeq).toBe(0);
    x.service.markRead({ operationKey: "read", issueId: result.issueId, throughSeq: 1 });
    expect(x.service.list().items[0]?.attentionReasons).toEqual(["waiting_user"]);
    const reply = x.service.reply({ operationKey: "reply", issueId: result.issueId, questionId: result.questionId, body: "A" });
    expect(x.service.list({ filter: "all" }).items[0]?.attentionReasons).toEqual([]);
    expect(x.service.list().items).toHaveLength(0);
    x.service.append(x.caller, { operationKey: "answer", issueId: result.issueId, kind: "answer", questionId: result.questionId, body: "A is done." });
    const shown = x.service.detail(result.issueId, { afterSeq: 0, limit: 2 });
    expect(shown.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(shown.displayedThroughSeq).toBe(2);
    expect(shown.hasMore).toBe(true);
    x.service.markRead({ operationKey: "read-shown", issueId: result.issueId, throughSeq: shown.displayedThroughSeq });
    x.service.markRead({ operationKey: "read-old", issueId: result.issueId, throughSeq: 1 });
    expect(x.service.detail(result.issueId).thread.readSeq).toBe(2);
    expect(x.service.list().items[0]?.attentionReasons).toEqual(["unread_lane_content"]);
    expect(() => x.service.markRead({ operationKey: "future", issueId: result.issueId, throughSeq: 999 })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(x.service.readForLane(x.caller, result.issueId, { afterSeq: reply.entrySeq, limit: 1 }).entries[0]?.body).toBe("A is done.");
  });

  it("saves a fixed delivery and replays normalized business keys across a restart", () => {
    const x = setup();
    const result = publishQuestion(x);
    const input = { operationKey: "reply", issueId: result.issueId, questionId: result.questionId, body: "Use A." };
    const reply = x.service.reply(input);
    const saved = x.service.detail(result.issueId).deliveries[0]!;
    expect(saved).toMatchObject({ id: reply.deliveryId, ownerLaneId: "lane-one", entryId: reply.entryId, handoffState: "pending", processedAt: null, sourceKind: "user", sourceOrigin: "issues" });
    for (const id of [result.issueId, reply.entryId, reply.deliveryId!]) expect(saved.body).toContain(id);
    expect(saved.body).toContain("lane_issue_read");
    expect(saved.body).toContain("无需回 TUI 重复");
    x.service.append(x.caller, { operationKey: "later", issueId: result.issueId, kind: "question", body: "Later question." });
    x.reopen();
    expect(x.service.reply({ body: "Use A.", questionId: result.questionId, issueId: result.issueId, operationKey: "reply" })).toEqual(reply);
    expect(x.service.detail(result.issueId).deliveries).toEqual([saved]);
    expect(() => x.service.reply({ ...input, body: "Use B." })).toThrowError(expect.objectContaining({ code: "OPERATION_CONFLICT" }));
    expect(x.service.detail(result.issueId).entries.filter((e) => e.body === "Use A.")).toHaveLength(1);
  });

  it("creates a follow-up for unselected replies without resolving all prior questions", () => {
    const x = setup();
    const first = publishQuestion(x);
    x.service.append(x.caller, { operationKey: "second", issueId: first.issueId, kind: "question", body: "Second?" });
    x.service.reply({ operationKey: "unselected", issueId: first.issueId, body: "Also check C." });
    const detail = x.service.detail(first.issueId);
    expect(detail.questions.map((q) => [q.askedTo, q.status])).toEqual([["user", "waiting_user"], ["user", "waiting_user"], ["lane", "waiting_lane"]]);
    expect(detail.thread.status).toBe("open");
  });

  it("retains completed-question reasons and answer links after later turns, paging, restart and replay", () => {
    const x = setup();
    const published = publishQuestion(x);
    const issueId = published.issueId;
    const questionId = published.questionId!;
    x.service.markRead({ operationKey: "initial-read", issueId, throughSeq: published.entrySeq });
    const reason = "Option A was superseded by the verified B result.";
    const notNeeded = { operationKey: "not-needed", issueId, questionId, status: "not_needed", reason } as const;
    const savedNotNeeded = x.service.updateQuestion(x.caller, notNeeded);
    expect(savedNotNeeded).toEqual({ issueId, questionId });
    expect(x.service.list({ filter: "all" }).items[0]?.attentionReasons).toEqual([]);
    x.service.reply({ operationKey: "follow-up", issueId, questionId, body: "Please explain the verification." });
    expect(x.service.detail(issueId).questions[0]).toMatchObject({ status: "waiting_lane", reason: null });
    // No questionId: an answer naming a question waiting on the lane now settles it by itself, and
    // this case is about the explicit resolve_question below and its replay.
    const answer = x.service.append(x.caller, { operationKey: "answer", issueId, kind: "answer", body: "B passed the full verification." });
    x.service.markRead({ operationKey: "answer-read", issueId, throughSeq: answer.entrySeq });
    const answered = { operationKey: "answered", issueId, questionId, status: "answered", answerEntryId: answer.entryId } as const;
    const savedAnswered = x.service.updateQuestion(x.caller, answered);
    expect(x.service.list({ filter: "all" }).items[0]?.attentionReasons).toEqual([]);
    x.service.append(x.caller, { operationKey: "clarify", issueId, questionId, kind: "explanation", body: "Please decide whether to apply B." });
    expect(x.service.detail(issueId).questions[0]).toMatchObject({ status: "waiting_user", answerEntryId: null, reason: null });
    x.reopen();

    const history: ReturnType<typeof x.service.detail>["entries"][number][] = [];
    let afterSeq = 0;
    for (;;) {
      const page = x.service.readForLane(x.caller, issueId, { afterSeq, limit: 1 });
      history.push(...page.entries);
      if (!page.hasMore) break;
      afterSeq = page.displayedThroughSeq;
    }
    const events = history.filter((entry) => entry.kind === "event");
    expect(events).toHaveLength(2);
    expect(events.some((entry) => entry.body.includes(reason))).toBe(true);
    expect(events.some((entry) => entry.body.includes(answer.entryId))).toBe(true);
    for (const event of events) {
      expect(event).toMatchObject({ relatedEntryId: published.entryId, author: "lane", source: "agent",
        recordedByBindingId: "binding:lane-one", recordedByGeneration: 1 });
    }
    expect(new Set(history.map((entry) => entry.id)).size).toBe(history.length);
    const beforeReplay = x.service.detail(issueId);
    expect(x.service.updateQuestion(x.caller, notNeeded)).toEqual(savedNotNeeded);
    expect(x.service.updateQuestion(x.caller, answered)).toEqual(savedAnswered);
    expect(x.service.detail(issueId)).toEqual(beforeReplay);
    x.service.close({ operationKey: "close", issueId, body: "Explicit end" });
    const closed = x.service.detail(issueId);
    expect(x.service.updateQuestion(x.caller, answered)).toEqual(savedAnswered);
    expect(x.service.detail(issueId)).toEqual(closed);
    expect(() => x.service.updateQuestion(x.caller, { ...notNeeded, operationKey: "after-close" }))
      .toThrowError(expect.objectContaining({ code: "ISSUE_CLOSED" }));
  });

  it("paginates equal-time threads by stable IDs and preserves content arriving after history was shown", () => {
    const x = setup();
    let id = 0;
    const service = new IssuesService({ store: x.store, lanes: x.access, now: () => 100, newId: () => `equal-${++id}` });
    const published = [1, 2, 3].map((number) => service.publish(x.caller, { operationKey: `p${number}`, title: `Thread ${number}`, kind: "question", body: `Q${number}?` }));
    const first = service.list({ filter: "all", limit: 1 });
    const second = service.list({ filter: "all", limit: 1, before: first.nextCursor! });
    const third = service.list({ filter: "all", limit: 1, before: second.nextCursor! });
    expect([...first.items, ...second.items, ...third.items].map((item) => item.id)).toEqual(published.map((item) => item.issueId).sort().reverse());
    expect(third.nextCursor).toBeNull();
    const issueId = published[0]!.issueId;
    const displayed = service.detail(issueId);
    service.append(x.caller, { operationKey: "new", issueId, kind: "answer", body: "Arrived after the page." });
    service.markRead({ operationKey: "shown", issueId, throughSeq: displayed.displayedThroughSeq });
    expect(service.detail(issueId).thread.readSeq).toBe(1);
    expect(service.list({ filter: "all" }).items.find((item) => item.id === issueId)?.attentionReasons).toContain("unread_lane_content");
  });
});
