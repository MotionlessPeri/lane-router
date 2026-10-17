import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueDeliveryWorker, openIssuesModule, openIssueStore } from "../../../src/modules/issues/index.js";
import * as issueStoreModule from "../../../src/modules/issues/store.js";
import { setupIssueRouter } from "../../fixtures/issues/router.js";

const fixtures: ReturnType<typeof setupIssueRouter>[] = [];
const workers: IssueDeliveryWorker[] = [];
const setup = () => { const x = setupIssueRouter(); fixtures.push(x); return x; };
const worker = (x: ReturnType<typeof setup>, delivery = x.core) => {
  const w = new IssueDeliveryWorker({ store: x.store, delivery, now: x.now }); workers.push(w); return w;
};
afterEach(async () => {
  for (const w of workers.splice(0)) await w.close();
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const x of fixtures.splice(0)) x.dispose();
});

describe("issue durable handoff worker", () => {
  it("uses only the saved target, source, body and request key after history changes and closure", async () => {
    const x = setup(); const { question, saved } = x.saveReply();
    x.service.append(x.caller, { operationKey: "later", issueId: question.issueId, kind: "question", body: "A later unrelated question" });
    x.service.close({ operationKey: "close", issueId: question.issueId, body: "End this discussion" });
    const deliver = vi.spyOn(x.core, "deliverUserMessage");
    const w = worker(x); await w.flush();
    expect(deliver).toHaveBeenCalledExactlyOnceWith({ target: { laneId: saved.ownerLaneId }, source: { kind: saved.sourceKind, origin: saved.sourceOrigin }, body: saved.body, requestKey: saved.requestKey });
    const result = x.store.delivery(saved.id)!;
    expect(result).toMatchObject({ handoffState: "accepted", coreMessageId: expect.any(String), attemptCount: 1, processedAt: null });
    expect(x.mailbox.readBody(x.state.requireMessage(result.coreMessageId!).relativePath)).toBe(saved.body);
    await w.flush(); expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("does not overlap one in-flight batch and close waits before any later record starts", async () => {
    const x = setup(); const { question, saved } = x.saveReply();
    const second = x.service.reply({ operationKey: "second", issueId: question.issueId, body: "Another reply" });
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    const realDeliver = x.core.deliverUserMessage.bind(x.core);
    const deliver = vi.spyOn(x.core, "deliverUserMessage").mockImplementation(async (input) => { entered(); await gate; return realDeliver(input); });
    const w = worker(x);
    const one = w.flush(); const two = w.flush();
    // The race has an explicit gate, with no wall-clock sleep.
    await Promise.race([entry, one]);
    expect(deliver).toHaveBeenCalledTimes(1);
    let closed = false; const closing = w.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release(); await Promise.all([one, two, closing]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(x.store.delivery(saved.id)?.handoffState).toBe("accepted");
    expect(x.store.delivery(second.deliveryId!)?.handoffState).toBe("pending");
    await expect(w.flush()).rejects.toThrow(/closed/i);
  });

  it("backs off transient delivery failures with a bounded interval and stops timers on close", async () => {
    vi.useFakeTimers(); const x = setup(); const { saved } = x.saveReply();
    const deliver = vi.spyOn(x.core, "deliverUserMessage").mockRejectedValue(new Error("temporary outage"));
    const w = worker(x); expect(vi.getTimerCount()).toBe(0); await w.start();
    expect(x.store.delivery(saved.id)).toMatchObject({ handoffState: "pending", attemptCount: 1, nextAttemptAt: 2_000, lastError: "temporary outage" });
    await w.flush(); expect(deliver).toHaveBeenCalledTimes(1);
    for (const delay of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      x.setTime(x.store.delivery(saved.id)!.nextAttemptAt);
      await w.flush();
      const result = x.store.delivery(saved.id)!;
      expect(result.nextAttemptAt - x.now()).toBe(delay);
    }
    x.setTime(x.store.delivery(saved.id)!.nextAttemptAt);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deliver).toHaveBeenCalledTimes(9);
    await w.close(); const calls = deliver.mock.calls.length;
    x.setTime(1_000_000); await vi.advanceTimersByTimeAsync(120_000);
    expect(deliver).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
  });

  it("persists known missing or archived refusals and never redirects or spins", async () => {
    const x = setup(); const { saved } = x.saveReply(); const replacement = x.archiveAndReplace();
    expect(replacement.id).not.toBe(saved.ownerLaneId);
    const deliver = vi.spyOn(x.core, "deliverUserMessage");
    const w = worker(x); await w.flush();
    expect(x.store.delivery(saved.id)).toMatchObject({ handoffState: "blocked", attemptCount: 1, lastTargetState: "archived", lastError: expect.stringContaining("archived"), coreMessageId: null });
    x.setTime(1_000_000); await w.flush(); expect(deliver).toHaveBeenCalledTimes(1);
    expect(x.state.allMessages()).toHaveLength(0); expect(x.fileCount()).toBe(0);
  });

  it("retains missing stable owner refusal without making a lane", async () => {
    const x = setup(); const { saved } = x.saveReply();
    // A module-only restore may refer to a stable lane absent from the core backup.
    const otherCore = setup();
    const deliver = vi.spyOn(otherCore.core, "deliverUserMessage");
    const w = new IssueDeliveryWorker({ store: x.store, delivery: otherCore.core, now: x.now }); workers.push(w);
    await w.flush(); x.setTime(1_000_000); await w.flush();
    expect(x.store.delivery(saved.id)).toMatchObject({ handoffState: "blocked", lastTargetState: "missing", lastError: expect.stringContaining("missing") });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(otherCore.state.laneById(saved.ownerLaneId)).toBeUndefined();
    expect(otherCore.state.allMessages()).toHaveLength(0);
  });

  it("leaves busy/offline notification recovery to the existing pump after mailbox acceptance", async () => {
    const x = setup(); const { saved } = x.saveReply();
    vi.mocked(x.backend.restorePresence).mockReturnValue("offline");
    vi.mocked(x.backend.notifyNormal).mockResolvedValueOnce("deferred");
    const deliver = vi.spyOn(x.core, "deliverUserMessage"); const w = worker(x);
    await w.flush(); const accepted = x.store.delivery(saved.id)!;
    expect(accepted).toMatchObject({ handoffState: "accepted", lastTargetState: "offline", processedAt: null });
    expect(x.state.pendingMessages(x.lane.address).map((m) => m.id)).toEqual([accepted.coreMessageId]);
    x.setTime(1_000_000); await w.flush(); expect(deliver).toHaveBeenCalledTimes(1);
    await x.pump.onAttentionOpportunity(x.lane.address);
    expect(x.notifications[0]?.messageIds).toEqual([accepted.coreMessageId]);
    expect(x.store.delivery(saved.id)?.processedAt).toBeNull();
  });

  it("does not overwrite an earlier processing receipt when handoff completes late", async () => {
    const x = setup(); const { saved } = x.saveReply();
    const realDeliver = x.core.deliverUserMessage.bind(x.core);
    vi.spyOn(x.core, "deliverUserMessage").mockImplementation(async (input) => {
      const result = await realDeliver(input);
      x.store.updateDeliveryProcessing(saved.id, { processedAt: 900, processedByBindingId: "earlier-binding", processedByGeneration: 7 });
      return result;
    });
    await worker(x).flush();
    expect(x.store.delivery(saved.id)).toMatchObject({ handoffState: "accepted", processedAt: 900, processedByBindingId: "earlier-binding", processedByGeneration: 7 });
  });

  it("reports a failed scheduled store write and later recovers without an unhandled rejection", async () => {
    vi.useFakeTimers(); const x = setup(); const { saved } = x.saveReply();
    const errors: unknown[] = [];
    const w = new IssueDeliveryWorker({ store: x.store, delivery: x.core, now: x.now, onError: (error) => { errors.push(error); } }); workers.push(w);
    await w.start();
    const second = x.service.reply({ operationKey: "second", issueId: saved.issueId, body: "Second" });
    vi.spyOn(x.store, "updateDeliveryHandoff").mockImplementationOnce(() => { throw new Error("module write unavailable"); });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(errors).toEqual([expect.objectContaining({ message: "module write unavailable" })]);
    expect(x.store.delivery(second.deliveryId!)?.handoffState).toBe("pending");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(x.store.delivery(second.deliveryId!)?.handoffState).toBe("accepted");
    expect(x.state.allMessages()).toHaveLength(2);
  });

  it("opens only explicitly and closes its module store after pending handoff settles", async () => {
    const x = setup(); const { saved } = x.saveReply();
    x.store.close();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    const realDeliver = x.core.deliverUserMessage.bind(x.core);
    const delivery = { deliverUserMessage: async (input: Parameters<typeof realDeliver>[0]) => { entered(); await gate; return realDeliver(input); } };
    const module = openIssuesModule({ databasePath: x.issuePath, lanes: x.core, delivery, now: x.now });
    const starting = module.start(); await Promise.race([entry, starting]);
    let closed = false; const closing = module.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release(); await Promise.all([starting, closing]);
    const reopened = openIssueStore(x.issuePath);
    try { expect(reopened.delivery(saved.id)?.handoffState).toBe("accepted"); } finally { reopened.close(); }
    expect(() => module.service.detail(saved.issueId)).toThrow();
  });

  it("reclaims its newly opened store if module construction fails, leaving the core usable", () => {
    const x = setup(); let opened: ReturnType<typeof openIssueStore> | undefined;
    vi.spyOn(issueStoreModule, "openIssueStore").mockImplementationOnce((path) => { opened = openIssueStore(path); return opened; });
    const options = { databasePath: x.issuePath, delivery: x.core, get lanes(): typeof x.core { throw new Error("dependency initialization failed"); } };
    try {
      expect(() => openIssuesModule(options)).toThrow("dependency initialization failed");
      expect(opened).toBeDefined();
      expect(() => opened!.pendingDeliveries(1_000, 10)).toThrow(/not open/i);
      expect(x.state.laneById(x.lane.id)?.address).toBe(x.lane.address);
    } finally { opened?.close(); }
  });
});
