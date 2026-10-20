import { afterEach, describe, expect, it, vi } from "vitest";

import type { IssueWakePort } from "../../../src/modules/issues/index.js";
import { setupIssues } from "../../fixtures/issues/setup.js";

const fixtures: ReturnType<typeof setupIssues>[] = [];
const setup = (options: Parameters<typeof setupIssues>[0] = {}) => { const x = setupIssues(options); fixtures.push(x); return x; };
afterEach(() => { for (const x of fixtures.splice(0)) x.dispose(); });

const OPENING = "用户在问答页新开了一个问答。这是用户本人的话，等同于在 TUI 里对你说的，按你处理用户指令的方式处理，不需要回 TUI 确认。答复写在这条问答里。";

/** Every row an issue write can leave, so a refusal can be shown to have left none. */
function saved(x: ReturnType<typeof setupIssues>) {
  const threads = x.service.list({ filter: "all" }).items.map(item => x.service.detail(item.id));
  return {
    threads: threads.length,
    entries: threads.flatMap(detail => detail.entries).length,
    questions: threads.flatMap(detail => detail.questions).length,
    deliveries: x.store.pendingDeliveries(Number.MAX_SAFE_INTEGER, 200).length,
  };
}

describe("a new issue started from the page", () => {
  it("saves the issue, its opening question, a question for the lane and one delivery in one go", () => {
    const x = setup();
    const created = x.service.create({ operationKey: "new", laneId: "lane-one", title: "  构建变慢  ", body: "帮我看看构建为什么慢" });
    const { issueId, entryId, questionId, deliveryId } = created;
    expect(created).toEqual({ issueId: expect.any(String), entryId: expect.any(String), entrySeq: 1, questionId: expect.any(String), deliveryId: expect.any(String) });

    const detail = x.service.detail(issueId);
    expect(detail.thread).toMatchObject({ ownerLaneId: "lane-one", title: "构建变慢", originKind: "question", status: "open", readSeq: 0, nextSeq: 2, closedAt: null });
    expect(detail.entries).toEqual([expect.objectContaining({ id: entryId, seq: 1, kind: "question", author: "user", source: "user_page",
      body: "帮我看看构建为什么慢", relatedEntryId: null, recordedByBindingId: null, recordedByGeneration: null })]);
    expect(detail.questions).toEqual([{ id: questionId, issueId, promptEntryId: entryId, askedTo: "lane", status: "waiting_lane", answerEntryId: null, reason: null }]);
    expect(detail.deliveries).toEqual([expect.objectContaining({ id: deliveryId, issueId, entryId, ownerLaneId: "lane-one", sourceKind: "user", sourceOrigin: "issues",
      requestKey: `issues:${deliveryId}`, handoffState: "pending", attemptCount: 0, processedAt: null })]);

    const body = detail.deliveries[0]!.body;
    expect(body.startsWith(`${OPENING}\n\n`)).toBe(true);
    expect(body).not.toContain("用户已在议题页面回复");
    expect(body).toContain(`议题 ID: ${issueId}\n标题: 构建变慢\n所属 lane ID: lane-one`);
    expect(body).toContain(`条目 entry ID: ${entryId}\n投递 delivery ID: ${deliveryId}\n问题 ID: ${questionId}`);
    expect(body).toContain("用户的话：\n帮我看看构建为什么慢");
    expect(body).toContain(`lane_issue_read，参数 ${JSON.stringify({ issueId })}`);
    expect(body).toContain(`lane_issue_append（kind: answer，questionId: ${questionId}）`);
    expect(body).toContain(`record_processed（deliveryId: ${deliveryId}）`);

    // Waiting on the lane, so under 进行中 and not under 待我处理.
    expect(x.service.list({ filter: "open" }).items).toEqual([expect.objectContaining({ id: issueId, waitingLaneCount: 1, waitingUserCount: 0, attentionReasons: [] })]);
    expect(x.service.list().items).toEqual([]);

    // The lane answers the question it was given, and that settles it, as for any reply.
    x.service.append(x.caller, { operationKey: "answer", issueId, kind: "answer", questionId, body: "缓存没命中。" });
    expect(x.service.detail(issueId).questions[0]).toMatchObject({ status: "answered" });
  });

  it("writes nothing when any part of the save fails", () => {
    const x = setup();
    vi.spyOn(x.store, "insertDelivery").mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => x.service.create({ operationKey: "new", laneId: "lane-one", title: "T", body: "B" })).toThrow("disk full");
    expect(saved(x)).toEqual({ threads: 0, entries: 0, questions: 0, deliveries: 0 });
    // Nothing was kept under the key either, so the same operation can go again.
    expect(x.service.create({ operationKey: "new", laneId: "lane-one", title: "T", body: "B" }).entrySeq).toBe(1);
  });

  it("refuses empty text, extra fields, and a lane that is unknown, archived or has no conversation, leaving no rows", () => {
    const x = setup();
    x.addLane("lane-unbound", "project/unbound");
    x.lanes.set("lane-unbound", { ...x.lanes.get("lane-unbound")!, binding: null });
    x.lanes.set("lane-two", { ...x.lanes.get("lane-two")!, archivedAt: 50 });
    const input = { operationKey: "new", laneId: "lane-one", title: "标题", body: "正文" };
    const refusals: Array<[object, string]> = [
      [{ ...input, title: "  " }, "INVALID_INPUT"], [{ ...input, body: " \n " }, "INVALID_INPUT"],
      [{ operationKey: "new", laneId: "lane-one", body: "正文" }, "INVALID_INPUT"], [{ ...input, laneId: "" }, "INVALID_INPUT"],
      [{ ...input, operationKey: "" }, "INVALID_INPUT"],
      ...["ownerLaneId", "author", "source", "questionId", "issueId", "actionToken"].map(field => [{ ...input, [field]: "spoof" }, "INVALID_INPUT"] as [object, string]),
      [{ ...input, laneId: "lane-ghost" }, "LANE_UNAVAILABLE"],
      [{ ...input, laneId: "lane-two" }, "LANE_UNAVAILABLE"],
      [{ ...input, laneId: "lane-unbound" }, "LANE_UNAVAILABLE"],
    ];
    for (const [value, code] of refusals) {
      expect(() => x.service.create(value as never), JSON.stringify(value)).toThrowError(expect.objectContaining({ code }));
    }
    expect(saved(x)).toEqual({ threads: 0, entries: 0, questions: 0, deliveries: 0 });
    expect(x.store.operation("user:local", "create", "new")).toBeNull();
  });

  it("replays the same key and content to the first result, across a restart and after the lane leaves, and refuses other content", () => {
    const x = setup();
    const input = { operationKey: "new", laneId: "lane-one", title: "标题", body: "正文" };
    const first = x.service.create(input);
    expect(x.service.create({ body: "正文", title: "标题", laneId: "lane-one", operationKey: "new" })).toEqual(first);
    x.reopen();
    x.lanes.set("lane-one", { ...x.lanes.get("lane-one")!, archivedAt: 50 });
    expect(x.service.create(input)).toEqual(first);
    expect(saved(x)).toEqual({ threads: 1, entries: 1, questions: 1, deliveries: 1 });
    for (const changed of [{ body: "别的正文" }, { title: "别的标题" }, { laneId: "lane-two" }]) {
      expect(() => x.service.create({ ...input, ...changed })).toThrowError(expect.objectContaining({ code: "OPERATION_CONFLICT" }));
    }
    expect(saved(x)).toEqual({ threads: 1, entries: 1, questions: 1, deliveries: 1 });
  });
});

describe("waking the lane an issue belongs to", () => {
  it("says nothing without a wake port", async () => {
    const x = setup();
    const { issueId } = x.service.create({ operationKey: "new", laneId: "lane-two", title: "T", body: "B" });
    await expect(x.service.wakeOwner(issueId)).resolves.toBeUndefined();
  });

  it("asks the port once for the issue's own lane and hands back what it said", async () => {
    const wake = vi.fn<IssueWakePort["wake"]>(async () => ({ status: "launch_requested" as const }));
    const x = setup({ wake: { wake } });
    const { issueId } = x.service.create({ operationKey: "new", laneId: "lane-two", title: "T", body: "B" });
    expect(wake).not.toHaveBeenCalled();
    await expect(x.service.wakeOwner(issueId)).resolves.toEqual({ status: "launch_requested" });
    expect(wake.mock.calls).toEqual([["lane-two"]]);
    wake.mockResolvedValueOnce({ status: "failed", reason: "session_not_found" });
    await expect(x.service.wakeOwner(issueId)).resolves.toEqual({ status: "failed", reason: "session_not_found" });
  });

  it("turns a port that throws into a failed wake rather than an error", async () => {
    const x = setup({ wake: { wake: async () => { throw new Error("spawn EPERM"); } } });
    const { issueId } = x.service.create({ operationKey: "new", laneId: "lane-one", title: "T", body: "B" });
    await expect(x.service.wakeOwner(issueId)).resolves.toEqual({ status: "failed", reason: "terminal_launch_failed" });
    expect(saved(x)).toEqual({ threads: 1, entries: 1, questions: 1, deliveries: 1 });
  });
});
