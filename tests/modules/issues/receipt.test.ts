import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueDeliveryWorker, type IssueDelivery, type IssueProcessedResult } from "../../../src/modules/issues/index.js";
import { setupIssueRouter } from "../../fixtures/issues/router.js";
import { publishQuestion, setupIssues } from "../../fixtures/issues/setup.js";

const fixtures: (ReturnType<typeof setupIssues> | ReturnType<typeof setupIssueRouter>)[] = [];
const workers: IssueDeliveryWorker[] = [];
const setup = () => { const x = setupIssues(); fixtures.push(x); return x; };
const router = () => { const x = setupIssueRouter(); fixtures.push(x); return x; };
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  vi.restoreAllMocks();
  for (const x of fixtures.splice(0)) x.dispose();
});

function saveReply(x: ReturnType<typeof setup>) {
  const question = publishQuestion(x);
  const reply = x.service.reply({ operationKey: "reply", issueId: question.issueId, questionId: question.questionId, body: "Use A." });
  return { question, reply, saved: x.store.delivery(reply.deliveryId!)! };
}

describe("issue business processing receipts", () => {
  it("keeps processing unconfirmed after notification and communication ACK without a business receipt", async () => {
    const x = router(); const { question, saved } = x.saveReply();
    const worker = new IssueDeliveryWorker({ store: x.store, delivery: x.core, now: x.now }); workers.push(worker);
    await worker.flush();
    const delivery = x.service.detail(question.issueId).deliveries[0]!;
    expect(x.notifications[0]?.messageIds).toEqual([delivery.coreMessageId]);
    expect(delivery).toMatchObject({ handoffState: "accepted", processedAt: null, processedByBindingId: null, processedByGeneration: null });
    await x.core.ack(x.caller, { messageIds: [delivery.coreMessageId!] });
    await worker.flush(); await worker.close(); x.reopen();
    expect(x.service.detail(question.issueId).deliveries[0]).toEqual(delivery);
    expect(x.state.requireMessage(delivery.coreMessageId!).state).toBe("resolved");
    expect(x.store.delivery(saved.id)?.processedAt).toBeNull();
    expect(x.fileCount()).toBe(1); expect(x.state.allMessages()).toHaveLength(1);
  });

  for (const interrupt of [false, true]) {
    it(`preserves an early receipt when the later handoff result ${interrupt ? "fails then recovers across both databases" : "arrives"}`, async () => {
      const x = router(); const { question, saved } = x.saveReply();
      const before = x.service.detail(question.issueId);
      let receipt: IssueProcessedResult | undefined;
      let early: IssueDelivery | null = null;
      const worker = new IssueDeliveryWorker({ store: x.store, now: x.now, delivery: {
        async deliverUserMessage(input) {
          const result = await x.core.deliverUserMessage(input);
          x.setTime(1_200);
          receipt = x.service.recordProcessed(x.caller, { operationKey: "processed", issueId: question.issueId, deliveryId: saved.id });
          early = x.store.delivery(saved.id);
          return result;
        },
      } }); workers.push(worker);
      if (interrupt) vi.spyOn(x.store, "updateDeliveryHandoff").mockImplementationOnce(() => { throw new Error("handoff result interrupted"); });
      if (interrupt) await expect(worker.flush()).rejects.toThrow("handoff result interrupted");
      else await worker.flush();
      await worker.close();
      expect(early).toMatchObject({ handoffState: "pending", coreMessageId: null,
        processedAt: 1_200, processedByBindingId: "binding-owner", processedByGeneration: 1 });
      const original = x.state.allMessages()[0]!;
      if (interrupt) {
        expect(x.store.delivery(saved.id)?.handoffState).toBe("pending");
        x.reopen();
        const recovery = new IssueDeliveryWorker({ store: x.store, delivery: x.core, now: x.now }); workers.push(recovery);
        await recovery.flush();
      }
      expect(receipt).toEqual({ issueId: question.issueId, deliveryId: saved.id, processedAt: 1_200 });
      const after = x.service.detail(question.issueId);
      expect(after.deliveries[0]).toEqual({ ...saved, handoffState: "accepted", coreMessageId: original.id, attemptCount: 1,
        nextAttemptAt: 1_200, lastTargetState: "online", processedAt: 1_200, processedByBindingId: "binding-owner", processedByGeneration: 1 });
      expect(after.thread).toEqual(before.thread); expect(after.entries).toEqual(before.entries); expect(after.questions).toEqual(before.questions);
      expect(x.state.allMessages()).toHaveLength(1); expect(x.fileCount()).toBe(1);
    });
  }

  it("replays the same operation after close, restart and binding rotation but refuses another first receipt", () => {
    const x = setup(); const { question, saved } = saveReply(x);
    const input = { operationKey: "processed", issueId: question.issueId, deliveryId: saved.id };
    const result = x.service.recordProcessed(x.caller, input);
    const first = x.store.delivery(saved.id)!;
    expect(first).toMatchObject({ processedAt: result.processedAt, processedByBindingId: "binding:lane-one", processedByGeneration: 1 });
    x.service.close({ operationKey: "close", issueId: question.issueId, body: "Ended" });
    x.reopen(); x.identities.set("lane-one", { laneId: "lane-one", bindingId: "rotated", generation: 2 });
    expect(x.service.recordProcessed({ ...x.caller, requestKey: "new-rpc" }, { deliveryId: saved.id, issueId: question.issueId, operationKey: "processed" })).toEqual(result);
    expect(() => x.service.recordProcessed(x.caller, { ...input, operationKey: "another-receipt" })).toThrowError(expect.objectContaining({ code: "OPERATION_CONFLICT" }));
    expect(x.store.delivery(saved.id)).toEqual(first);
    expect(x.store.operation("lane:lane-one", "record_processed", "another-receipt")).toBeNull();
  });

  it("rejects same-key changed input, cross-issue, unknown delivery and a foreign lane with no partial writes", () => {
    const x = setup(); const { question, saved } = saveReply(x);
    const second = publishQuestion(x, "Other?", "second");
    const reply = x.service.reply({ operationKey: "second-reply", issueId: second.issueId, body: "Use B." });
    const input = { operationKey: "processed", issueId: question.issueId, deliveryId: saved.id };
    const result = x.service.recordProcessed(x.caller, input);
    for (const deliveryId of [reply.deliveryId!, "unknown"]) {
      expect(() => x.service.recordProcessed(x.caller, { ...input, operationKey: "wrong-delivery", deliveryId })).toThrowError(expect.objectContaining({ code: "INVALID_REFERENCE" }));
      expect(x.store.operation("lane:lane-one", "record_processed", "wrong-delivery")).toBeNull();
    }
    expect(() => x.service.recordProcessed(x.other, input)).toThrowError(expect.objectContaining({ code: "ISSUE_NOT_FOUND" }));
    expect(() => x.service.recordProcessed(x.caller, { ...input, issueId: second.issueId, deliveryId: reply.deliveryId! })).toThrowError(expect.objectContaining({ code: "OPERATION_CONFLICT" }));
    expect(x.service.recordProcessed(x.caller, input)).toEqual(result);
    expect(x.store.delivery(reply.deliveryId!)?.processedAt).toBeNull();
  });

  it("rejects another lane's delivery even when the caller owns the supplied issue", () => {
    const x = setup(); const { question, saved } = saveReply(x);
    const foreign = x.service.publish(x.other, { operationKey: "foreign", title: "Other lane", kind: "question", body: "Which?" });
    const reply = x.service.reply({ operationKey: "foreign-reply", issueId: foreign.issueId, body: "Use B." });
    expect(() => x.service.recordProcessed(x.caller, { operationKey: "bad-owner", issueId: question.issueId, deliveryId: reply.deliveryId! })).toThrowError(expect.objectContaining({ code: "INVALID_REFERENCE" }));
    expect(x.store.delivery(reply.deliveryId!)?.processedAt).toBeNull();
    expect(x.store.delivery(saved.id)?.processedAt).toBeNull();
    expect(x.store.operation("lane:lane-one", "record_processed", "bad-owner")).toBeNull();
  });

  it("checks the current caller again before a new receipt or a successful replay", () => {
    const x = setup(); const { question, saved } = saveReply(x);
    const input = { operationKey: "processed", issueId: question.issueId, deliveryId: saved.id };
    x.beforeAssert(() => { x.identities.set("lane-one", { laneId: "lane-one", bindingId: "rotated", generation: 2 }); });
    expect(() => x.service.recordProcessed(x.caller, input)).toThrowError(expect.objectContaining({ code: "BINDING_CHANGED" }));
    expect(x.store.delivery(saved.id)?.processedAt).toBeNull();
    expect(x.store.operation("lane:lane-one", "record_processed", "processed")).toBeNull();
    x.beforeAssert(() => undefined);
    const receipt = x.service.recordProcessed(x.caller, input);
    expect(x.store.delivery(saved.id)).toMatchObject({ processedByBindingId: "rotated", processedByGeneration: 2 });
    x.beforeAssert(() => { x.identities.delete("lane-one"); });
    expect(() => x.service.recordProcessed(x.caller, input)).toThrowError(expect.objectContaining({ code: "BINDING_CHANGED" }));
    expect(x.store.delivery(saved.id)?.processedAt).toBe(receipt.processedAt);
  });

  for (const state of ["archived", "missing"] as const) {
    it(`rejects a new receipt for a ${state} owner while retaining an authorized successful replay`, () => {
      const x = setup(); const { question, saved } = saveReply(x);
      const other = x.service.reply({ operationKey: "another", issueId: question.issueId, body: "Also this." });
      const input = { operationKey: "processed", issueId: question.issueId, deliveryId: saved.id };
      const receipt = x.service.recordProcessed(x.caller, input);
      if (state === "archived") x.lanes.set("lane-one", { ...x.lanes.get("lane-one")!, archivedAt: 2_000 });
      else x.lanes.delete("lane-one");
      expect(() => x.service.recordProcessed(x.caller, { ...input, operationKey: "new", deliveryId: other.deliveryId! })).toThrowError(expect.objectContaining({ code: "LANE_UNAVAILABLE" }));
      expect(x.service.recordProcessed(x.caller, input)).toEqual(receipt);
      expect(x.store.delivery(other.deliveryId!)?.processedAt).toBeNull();
      expect(x.store.operation("lane:lane-one", "record_processed", "new")).toBeNull();
    });
  }

  for (const fault of ["updateDeliveryProcessing", "insertOperation"] as const) {
    it(`rolls back both processing and its operation result when ${fault} fails after writing`, () => {
      const x = setup(); const { question, saved } = saveReply(x);
      const input = { operationKey: "processed", issueId: question.issueId, deliveryId: saved.id };
      if (fault === "updateDeliveryProcessing") {
        const write = x.store.updateDeliveryProcessing.bind(x.store);
        vi.spyOn(x.store, fault).mockImplementationOnce((id, processing) => { write(id, processing); throw new Error("receipt commit interrupted"); });
      } else {
        const write = x.store.insertOperation.bind(x.store);
        vi.spyOn(x.store, fault).mockImplementationOnce((operation) => { write(operation); throw new Error("receipt commit interrupted"); });
      }
      expect(() => x.service.recordProcessed(x.caller, input)).toThrow("receipt commit interrupted");
      expect(x.store.delivery(saved.id)).toEqual(saved);
      expect(x.store.operation("lane:lane-one", "record_processed", "processed")).toBeNull();
      x.reopen();
      const result = x.service.recordProcessed(x.caller, input);
      expect(x.store.delivery(saved.id)).toMatchObject({ id: saved.id, processedAt: result.processedAt, processedByBindingId: "binding:lane-one", processedByGeneration: 1 });
      expect(x.store.operation("lane:lane-one", "record_processed", "processed")?.resultJson).toBe(JSON.stringify(result));
    });
  }

  for (const field of ["bindingId", "generation", "processedAt", "confirmed", "coreMessageId"]) {
    it(`does not accept a model-supplied ${field}`, () => {
      const x = setup(); const { question, saved } = saveReply(x);
      expect(() => x.service.recordProcessed(x.caller, { operationKey: "forged", issueId: question.issueId, deliveryId: saved.id, [field]: "forged" } as never)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
      expect(x.store.delivery(saved.id)).toEqual(saved);
      expect(x.store.operation("lane:lane-one", "record_processed", "forged")).toBeNull();
    });
  }
});
