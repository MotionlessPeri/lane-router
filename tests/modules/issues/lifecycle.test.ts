import { afterEach, describe, expect, it } from "vitest";

import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

const fixtures: ReturnType<typeof setupIssues>[] = [];
const setup = () => { const x = setupIssues(); fixtures.push(x); return x; };
afterEach(() => { for (const x of fixtures.splice(0)) x.dispose(); });

describe("issue identity and lifecycle", () => {
  it("isolates lanes by stable binding identity and rejects stale generations before writing", () => {
    const x = setup();
    const result = publishQuestion(x);
    expect(x.service.listForLane(x.other, { filter: "all" }).items).toEqual([]);
    for (const operation of [() => x.service.readForLane(x.other, result.issueId), () => x.service.append(x.other, { operationKey: "foreign", issueId: result.issueId, kind: "answer", body: "stolen" })]) {
      expect(operation).toThrowError(expect.objectContaining({ code: "ISSUE_NOT_FOUND" }));
    }
    x.beforeAssert(() => { x.identities.set("lane-one", { laneId: "lane-one", bindingId: "new-binding", generation: 2 }); });
    expect(() => x.service.append(x.caller, { operationKey: "stale", issueId: result.issueId, kind: "answer", body: "stale" })).toThrowError(expect.objectContaining({ code: "BINDING_CHANGED" }));
    expect(x.service.detail(result.issueId).entries).toHaveLength(1);
  });

  it("rejects archived stable owners even with a legacy active binding and reused address", () => {
    const x = setup();
    const result = publishQuestion(x);
    const original = x.lanes.get("lane-one")!;
    x.lanes.set("lane-one", { ...original, archivedAt: 100 });
    const replacement = x.addLane("new-lane", original.address);
    expect(x.service.detail(result.issueId).owner).toEqual({ laneId: "lane-one", address: original.address, state: "archived" });
    expect(x.service.list({ filter: "all" }).items[0]?.owner).toEqual({ laneId: "lane-one", address: original.address, state: "archived" });
    expect(x.service.listForLane(replacement, { filter: "all" }).items).toEqual([]);
    expect(() => x.service.readForLane(replacement, result.issueId)).toThrowError(expect.objectContaining({ code: "ISSUE_NOT_FOUND" }));
    expect(x.service.readForLane(x.caller, result.issueId).thread.ownerLaneId).toBe("lane-one");
    expect(() => x.service.append(x.caller, { operationKey: "archived", issueId: result.issueId, kind: "answer", body: "no" })).toThrowError(expect.objectContaining({ code: "LANE_UNAVAILABLE" }));
    expect(() => x.service.reply({ operationKey: "archived", issueId: result.issueId, body: "no" })).toThrowError(expect.objectContaining({ code: "LANE_UNAVAILABLE" }));
    x.lanes.delete("lane-one");
    expect(x.service.detail(result.issueId).owner).toEqual({ laneId: "lane-one", address: null, state: "missing" });
    expect(() => x.service.reply({ operationKey: "missing", issueId: result.issueId, body: "no" })).toThrowError(expect.objectContaining({ code: "LANE_UNAVAILABLE" }));
  });

  it("allows only explicit user close, keeps prior replies and replays successes after close", () => {
    const x = setup();
    const published = publishQuestion(x);
    const replyInput = { operationKey: "reply", issueId: published.issueId, body: "Please proceed.", questionId: published.questionId };
    const reply = x.service.reply(replyInput);
    const appended = x.service.append(x.caller, { operationKey: "a", issueId: published.issueId, kind: "answer", body: "Done." });
    x.service.close({ operationKey: "close", issueId: published.issueId, body: "Explicitly ended on the page." });
    expect(x.service.detail(published.issueId).thread).toMatchObject({ status: "closed", closedAt: expect.any(Number) });
    expect(x.service.detail(published.issueId).deliveries).toHaveLength(1);
    expect(x.service.reply(replyInput)).toEqual(reply);
    expect(x.service.append(x.caller, { operationKey: "a", issueId: published.issueId, kind: "answer", body: "Done." })).toEqual(appended);
    expect(x.service.publish(x.caller, { operationKey: "publish", title: "Choose", kind: "question", body: "Which option?" })).toEqual(published);
    expect(() => x.service.reply({ ...replyInput, operationKey: "new" })).toThrowError(expect.objectContaining({ code: "ISSUE_CLOSED" }));
    expect(() => x.service.append(x.caller, { operationKey: "later", issueId: published.issueId, kind: "answer", body: "new" })).toThrowError(expect.objectContaining({ code: "ISSUE_CLOSED" }));
    expect(() => x.service.updateQuestion(x.caller, { operationKey: "end", issueId: published.issueId, questionId: published.questionId!, status: "closed" } as never)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(x.service.list({ filter: "closed" }).items[0]?.attentionReasons).toEqual([]);
    const closed = x.service.detail(published.issueId);
    x.service.markRead({ operationKey: "read-closed", issueId: published.issueId, throughSeq: closed.displayedThroughSeq });
    const readClosed = x.service.detail(published.issueId);
    expect(readClosed.entries).toEqual(closed.entries);
    expect(readClosed.questions).toEqual(closed.questions);
    expect(readClosed.thread).toEqual({ ...closed.thread, readSeq: closed.displayedThroughSeq });
    expect(x.service.list({ filter: "closed" }).items[0]?.attentionReasons).toEqual([]);
  });

  it("records actual TUI user closure with provenance and refuses subsequent discussion", () => {
    const x = setup();
    const result = publishQuestion(x);
    x.service.recordTuiClose(x.caller, { operationKey: "tui-end", issueId: result.issueId, body: "用户原话：这个事情结束了" });
    expect(x.service.detail(result.issueId).entries.at(-1)).toMatchObject({ kind: "event", author: "user", source: "agent_reported_tui_user", body: "用户原话：这个事情结束了", recordedByBindingId: "binding:lane-one", recordedByGeneration: 1 });
    expect(x.service.detail(result.issueId).deliveries).toHaveLength(0);
    expect(() => x.service.append(x.caller, { operationKey: "after", issueId: result.issueId, kind: "tui_user", body: "too late" })).toThrowError(expect.objectContaining({ code: "ISSUE_CLOSED" }));
  });

  it("validates same-issue associations, meaningful answers and actor access before replay", () => {
    const x = setup();
    const first = publishQuestion(x);
    const second = publishQuestion(x, "Other?", "second");
    expect(() => x.service.reply({ operationKey: "cross", issueId: first.issueId, questionId: second.questionId, body: "wrong" })).toThrowError(expect.objectContaining({ code: "INVALID_REFERENCE" }));
    expect(() => x.service.updateQuestion(x.caller, { operationKey: "wrong", issueId: first.issueId, questionId: first.questionId!, status: "answered", answerEntryId: second.entryId })).toThrowError(expect.objectContaining({ code: "INVALID_REFERENCE" }));
    expect(() => x.service.updateQuestion(x.caller, { operationKey: "prompt", issueId: first.issueId, questionId: first.questionId!, status: "answered", answerEntryId: first.entryId })).toThrowError(expect.objectContaining({ code: "INVALID_REFERENCE" }));
    expect(() => x.service.updateQuestion(x.caller, { operationKey: "empty", issueId: first.issueId, questionId: first.questionId!, status: "not_needed", reason: " " })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    x.service.close({ operationKey: "close", issueId: first.issueId, body: "Ended" });
    expect(() => x.service.append(x.other, { operationKey: "publish", issueId: first.issueId, kind: "answer", body: "no" })).toThrowError(expect.objectContaining({ code: "ISSUE_NOT_FOUND" }));
  });

  it("uses stable lane scopes across binding rotation without treating RPC IDs as operation keys", () => {
    const x = setup();
    const first = publishQuestion(x);
    x.identities.set("lane-one", { laneId: "lane-one", bindingId: "rotated", generation: 2 });
    expect(x.service.publish({ ...x.caller, requestKey: "different-rpc" }, { operationKey: "publish", title: "Choose", kind: "question", body: "Which option?" })).toEqual(first);
    expect(() => publishQuestion(x, "Different", "publish")).toThrowError(expect.objectContaining({ code: "OPERATION_CONFLICT" }));
    expect(x.service.listForLane(x.caller, { filter: "all" }).items).toHaveLength(1);
  });
});
