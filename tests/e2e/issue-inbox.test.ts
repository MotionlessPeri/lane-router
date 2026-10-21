import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueDeliveryWorker } from "../../src/modules/issues/index.js";
import type { IssueDetail, IssueEntryResult, IssueList } from "../../src/modules/issues/types.js";
import { setupIssueRouter, startIssueAdapters } from "../fixtures/issues/router.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function setup() {
  const x = setupIssueRouter(); cleanup.push(() => x.dispose()); return x;
}
async function adapters(x: ReturnType<typeof setup>) {
  const a = await startIssueAdapters(x); cleanup.push(a.close); return a;
}
function worker(x: ReturnType<typeof setup>) {
  const w = new IssueDeliveryWorker({ store: x.store, delivery: x.core, now: x.now });
  cleanup.push(() => w.close()); return w;
}
async function result<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return (await response.json() as { result: T }).result;
}
const publish = { operationKey: "publish", title: "选择方案", kind: "question", body: "选择 A 还是 B？\n请确认取舍。" };

describe("issue inbox across real adapters and independent durable stores", () => {
  it("publishes, replies, reads full mailbox context, processes with tools, ends on user close and reopens on a later reply", async () => {
    const x = setup(); const a = await adapters(x);
    expect(a.applicationTools.catalog.definitions).toHaveLength(15);
    const question = await a.call("lane_issue_publish", publish) as IssueEntryResult;
    expect((await result<IssueList>(await a.get())).items[0]).toMatchObject({ id: question.issueId, waitingUserCount: 1 });
    const detail = await result<IssueDetail>(await a.get(`/issues/api/threads/${question.issueId}`));
    expect(detail.entries.map(entry => entry.body)).toEqual([publish.body]);
    await result(await a.post(question.issueId, "read", { operationKey: "read", throughSeq: detail.displayedThroughSeq }));
    expect((await result<IssueList>(await a.get())).items[0]?.attentionReasons).toEqual(["waiting_user"]);

    const body = "  请先解释 A 的成本。\n保留缩进与末尾换行。\n";
    const reply = await result<IssueEntryResult>(await a.post(question.issueId, "replies", { operationKey: "reply", questionId: question.questionId, body }));
    const w = worker(x); await w.flush();
    const saved = x.store.delivery(reply.deliveryId!)!;
    expect(saved).toMatchObject({ handoffState: "accepted", processedAt: null, ownerLaneId: x.lane.id });
    const message = x.state.requireMessage(saved.coreMessageId!);
    const completeBody = x.mailbox.readBody(message.relativePath);
    expect(completeBody).toBe(saved.body);
    for (const text of [publish.body, body, question.issueId, reply.entryId, reply.deliveryId!, "lane_issue_read"]) expect(completeBody).toContain(text);
    const agentView = await a.call("lane_issue_read", { issueId: question.issueId }) as IssueDetail;
    expect(agentView.entries.find(entry => entry.id === reply.entryId)?.body).toBe(body);
    expect(agentView.questions[0]?.status).toBe("waiting_lane");
    await a.cli("append", { operationKey: "explain", issueId: question.issueId, kind: "explanation", questionId: question.questionId, body: "A 的成本较低，仍请用户确认。" });
    await a.cli("update", { operationKey: "processed", issueId: question.issueId, action: "record_processed", deliveryId: reply.deliveryId });
    await a.call("lane_ack", { message_ids: [message.id] });
    expect(x.state.requireMessage(message.id).state).toBe("resolved");
    expect(x.store.delivery(reply.deliveryId!)?.processedAt).toBe(x.now());
    expect((await result<IssueList>(await a.get())).items[0]).toMatchObject({ status: "open", waitingUserCount: 1 });
    const answer = await a.call("lane_issue_append", { operationKey: "answer", issueId: question.issueId, kind: "answer", questionId: question.questionId, body: "已给出完整取舍说明。" }) as IssueEntryResult;
    await a.call("lane_issue_update", { operationKey: "resolve", issueId: question.issueId, action: "resolve_question", questionId: question.questionId, status: "answered", answerEntryId: answer.entryId });
    expect((await result<IssueDetail>(await a.get(`/issues/api/threads/${question.issueId}`))).thread.status).toBe("open");
    await result(await a.post(question.issueId, "close", { operationKey: "close", body: "我确认本议题结束。" }));
    expect((await result<IssueList>(await a.get("/issues/api/threads?filter=closed"))).items[0]?.id).toBe(question.issueId);
    // A reply after the end reopens the issue rather than being refused.
    await result(await a.post(question.issueId, "replies", { operationKey: "late", body: "late" }));
    expect((await result<IssueDetail>(await a.get(`/issues/api/threads/${question.issueId}`))).thread).toMatchObject({ status: "open", closedBy: null });
  });

  it("syncs actual related TUI input and dedicated user closure through JSON-file CLI without echo delivery", async () => {
    const x = setup(); const a = await adapters(x);
    const issue = await a.cli("publish", { operationKey: "tui-publish", title: "TUI 答复", kind: "answer", originalQuestion: "用户原问题", body: "已完成答复" }) as IssueEntryResult;
    const input = "用户在 TUI 追问的原话\n第二行";
    await a.cli("append", { operationKey: "tui-input", issueId: issue.issueId, kind: "tui_user", questionId: issue.questionId, body: input });
    await worker(x).flush();
    const detail = await result<IssueDetail>(await a.get(`/issues/api/threads/${issue.issueId}`));
    expect(detail.entries.at(-1)).toMatchObject({ body: input, author: "user", source: "agent_reported_tui_user" });
    expect(detail.questions[0]?.status).toBe("waiting_lane");
    expect(detail.deliveries).toEqual([]); expect(x.state.allMessages()).toEqual([]); expect(x.fileCount()).toBe(0);
    await a.cli("record-tui-close", { operationKey: "tui-close", issueId: issue.issueId, body: "用户原话：这个议题结束。" });
    expect((await a.call("lane_issue_read", { issueId: issue.issueId }) as IssueDetail).thread.status).toBe("closed");
  });

  it.each(["busy", "offline"] as const)("keeps %s input durable across both stores reopening and leaves wakeup to the pump", async mode => {
    const x = setup(); let a = await adapters(x);
    vi.mocked(x.backend.restorePresence).mockReturnValue(mode === "offline" ? "offline" : "online");
    vi.mocked(x.backend.notifyNormal).mockResolvedValue(mode === "busy" ? "deferred" : "no_channel");
    const issue = await a.call("lane_issue_publish", publish) as IssueEntryResult;
    const reply = await result<IssueEntryResult>(await a.post(issue.issueId, "replies", { operationKey: "durable", body: `saved while ${mode}` }));
    // Exit before a worker starts: the saved transaction owns subsequent delivery.
    await a.close(); x.reopen(); a = await adapters(x);
    const w = worker(x); await w.flush(); const saved = x.store.delivery(reply.deliveryId!)!;
    expect(saved).toMatchObject({ handoffState: "accepted", processedAt: null, lastTargetState: mode === "offline" ? "offline" : "online" });
    expect(x.state.pendingMessages(x.lane.address).map(message => message.id)).toEqual([saved.coreMessageId]);
    await w.close(); await a.close(); x.reopen(); a = await adapters(x);
    await worker(x).flush();
    expect(x.state.allMessages()).toHaveLength(1); expect(x.fileCount()).toBe(1);
    vi.mocked(x.backend.notifyNormal).mockImplementation(async (_binding, notification) => { x.notifications.push(notification); return "sent"; });
    await x.pump.onAttentionOpportunity(x.lane.address);
    expect(x.notifications.at(-1)?.messageIds).toEqual([saved.coreMessageId]);
    expect((await result<IssueDetail>(await a.get(`/issues/api/threads/${issue.issueId}`))).deliveries[0]).toMatchObject({ id: saved.id, processedAt: null });
  });

  it("recovers an uncertain real HTTP response loss with the same key and original IDs after reopen", async () => {
    const x = setup(); let a = await adapters(x);
    const issue = await a.call("lane_issue_publish", publish) as IssueEntryResult;
    const input = { operationKey: "uncertain", questionId: issue.questionId, body: "提交已保存但响应丢失\n精确保留正文。" };
    let requests = 0;
    // A fixture transport drops the consumer socket only after the real server has committed
    // and produced a response. No fault hook or alternate business implementation is involved.
    const transport = createServer((request, response) => {
      requests += 1;
      const upstream = httpRequest(`${a.url}${request.url}`, { method: request.method,
        headers: { ...request.headers, host: new URL(a.url).host, origin: a.url } }, received => {
        received.resume(); response.destroy();
      });
      upstream.on("error", error => response.destroy(error)); request.pipe(upstream);
    });
    await new Promise<void>(resolve => transport.listen(0, "127.0.0.1", resolve));
    const closeTransport = () => new Promise<void>((resolve, reject) => transport.close(error => error ? reject(error) : resolve()));
    cleanup.push(closeTransport);
    const url = `http://127.0.0.1:${(transport.address() as AddressInfo).port}`;
    const token = (await (await a.get()).json() as { actionToken: string }).actionToken;
    await expect(fetch(`${url}/issues/api/threads/${issue.issueId}/replies`, {
      method: "POST", headers: { origin: url, "content-type": "application/json", "x-lane-router-action": "issues-reply" }, body: JSON.stringify({ actionToken: token, ...input }),
    })).rejects.toThrow(/fetch failed/);
    expect(requests).toBe(1);
    const original = x.service.detail(issue.issueId).deliveries[0]!;
    expect(original).toMatchObject({ handoffState: "pending", processedAt: null }); expect(x.state.allMessages()).toHaveLength(0);
    await a.close(); x.reopen(); a = await adapters(x);
    const history = await result<IssueDetail>(await a.get(`/issues/api/threads/${issue.issueId}`));
    expect(history.entries.find(entry => entry.id === original.entryId)?.body).toBe(input.body);
    const retry = await result<IssueEntryResult>(await a.post(issue.issueId, "replies", input));
    expect(retry).toMatchObject({ entryId: original.entryId, deliveryId: original.id });
    await worker(x).flush();
    expect(x.state.allMessages()).toHaveLength(1); expect(x.fileCount()).toBe(1);
    expect(x.service.detail(issue.issueId).deliveries).toHaveLength(1);
    expect(x.store.delivery(original.id)).toMatchObject({ handoffState: "accepted", processedAt: null });
  });

  it("retains the original stable owner history and never hands it to a same-address replacement", async () => {
    const x = setup(); let a = await adapters(x);
    const issue = await a.call("lane_issue_publish", publish) as IssueEntryResult;
    const reply = await result<IssueEntryResult>(await a.post(issue.issueId, "replies", { operationKey: "saved", body: "仅原 lane 可收" }));
    await a.close(); const replacement = x.archiveAndReplace();
    x.state.createBinding({ id: "binding-replacement", laneAddress: replacement.address, backend: "codex", conversationId: "replacement-thread", generation: 1, startup: {}, now: x.now() });
    x.reopen(); a = await adapters(x); await worker(x).flush();
    expect(replacement.id).not.toBe(x.lane.id);
    expect(x.store.delivery(reply.deliveryId!)).toMatchObject({ ownerLaneId: x.lane.id, handoffState: "blocked", lastTargetState: "archived", coreMessageId: null });
    const history = await result<IssueDetail>(await a.get(`/issues/api/threads/${issue.issueId}`));
    expect(history.owner).toMatchObject({ laneId: x.lane.id, state: "archived" });
    expect(history.entries.at(-1)?.body).toBe("仅原 lane 可收");
    const replacementCaller = { ...x.caller, conversationId: "replacement-thread" };
    await expect(a.client.call("lane_issue_read", { issueId: issue.issueId }, replacementCaller)).rejects.toMatchObject({ code: "ISSUE_NOT_FOUND" });
    expect(await a.client.call("lane_issue_read", {}, replacementCaller)).toMatchObject({ items: [] });
    const rejected = await a.post(issue.issueId, "replies", { operationKey: "wrong-target", body: "不可改挂" });
    expect(rejected.status).toBe(409); expect(await rejected.json()).toMatchObject({ code: "LANE_UNAVAILABLE" });
    expect(x.state.allMessages()).toEqual([]); expect(x.fileCount()).toBe(0);
  });
});
