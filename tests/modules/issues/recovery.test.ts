import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueDeliveryWorker } from "../../../src/modules/issues/index.js";
import { setupIssueRouter } from "../../fixtures/issues/router.js";

const fixtures: ReturnType<typeof setupIssueRouter>[] = [];
const workers: IssueDeliveryWorker[] = [];
const setup = () => { const x = setupIssueRouter(); fixtures.push(x); return x; };
const worker = (x: ReturnType<typeof setup>) => { const w = new IssueDeliveryWorker({ store: x.store, delivery: x.core, now: x.now }); workers.push(w); return w; };
afterEach(async () => {
  for (const w of workers.splice(0)) await w.close();
  vi.restoreAllMocks(); for (const x of fixtures.splice(0)) x.dispose();
});

describe("issue handoff crash windows with persistent independent stores", () => {
  it("recovers a saved reply on startup after both stores close before any delivery call", async () => {
    const x = setup(); const { saved } = x.saveReply();
    expect(x.state.allMessages()).toHaveLength(0); x.reopen();
    const w = worker(x); await w.start(); await w.close();
    const result = x.store.delivery(saved.id)!;
    expect(result).toMatchObject({ handoffState: "accepted", coreMessageId: expect.any(String), processedAt: null });
    expect(x.state.allMessages()).toHaveLength(1); expect(x.fileCount()).toBe(1);
    expect(x.mailbox.readBody(x.state.requireMessage(result.coreMessageId!).relativePath)).toBe(saved.body);
  });

  it("reuses the original core message after acceptance but before the module result is saved", async () => {
    const x = setup(); const { saved } = x.saveReply();
    vi.spyOn(x.store, "updateDeliveryHandoff").mockImplementationOnce(() => { throw new Error("crash before module commit"); });
    const first = worker(x); await expect(first.flush()).rejects.toThrow("crash before module commit"); await first.close();
    const original = x.state.allMessages()[0]!;
    expect(original).toBeDefined(); expect(x.store.delivery(saved.id)?.handoffState).toBe("pending");
    x.reopen(); await worker(x).flush();
    expect(x.store.delivery(saved.id)?.coreMessageId).toBe(original.id);
    expect(x.state.allMessages()).toHaveLength(1); expect(x.fileCount()).toBe(1);
  });

  it("repairs a file-before-index interruption across reopening both databases with the same message ID", async () => {
    const x = setup(); const { saved } = x.saveReply();
    vi.spyOn(x.state, "insertMessage").mockImplementationOnce(() => { throw new Error("core index interrupted"); });
    const first = worker(x); await first.flush(); await first.close();
    expect(x.store.delivery(saved.id)).toMatchObject({ handoffState: "pending", attemptCount: 1, lastError: "core index interrupted" });
    expect(x.state.allMessages()).toHaveLength(0); expect(x.fileCount()).toBe(1);
    expect(x.reopen()).toMatchObject({ recovered: 1 });
    const original = x.state.allMessages()[0]!; x.setTime(x.store.delivery(saved.id)!.nextAttemptAt);
    await worker(x).flush();
    expect(x.store.delivery(saved.id)?.coreMessageId).toBe(original.id);
    expect(x.state.allMessages()).toHaveLength(1); expect(x.fileCount()).toBe(1);
    expect(x.mailbox.readBody(original.relativePath)).toBe(saved.body);
  });

  it("retries notification failure after restart without creating another message or claiming processing", async () => {
    const x = setup(); const { saved } = x.saveReply();
    vi.mocked(x.backend.notifyNormal).mockRejectedValueOnce(new Error("notification interrupted"));
    const first = worker(x); await first.flush(); await first.close();
    const original = x.state.allMessages()[0]!;
    expect(x.store.delivery(saved.id)).toMatchObject({ handoffState: "pending", lastError: "notification interrupted", processedAt: null });
    x.reopen(); x.setTime(x.store.delivery(saved.id)!.nextAttemptAt); await worker(x).flush();
    expect(x.store.delivery(saved.id)).toMatchObject({ handoffState: "accepted", coreMessageId: original.id, processedAt: null });
    expect(x.notifications[0]?.messageIds).toEqual([original.id]); expect(x.fileCount()).toBe(1);
  });

  it("recovers an ACKed original when the module still has no accepted result", async () => {
    const x = setup(); const { saved } = x.saveReply();
    vi.spyOn(x.store, "updateDeliveryHandoff").mockImplementationOnce(() => { throw new Error("module interrupted"); });
    const first = worker(x); await expect(first.flush()).rejects.toThrow("module interrupted"); await first.close();
    const original = x.state.allMessages()[0]!;
    await x.core.ack(x.caller, { messageIds: [original.id] });
    x.reopen(); await worker(x).flush();
    expect(x.store.delivery(saved.id)).toMatchObject({ handoffState: "accepted", coreMessageId: original.id, processedAt: null });
    expect(x.state.requireMessage(original.id).state).toBe("resolved");
    expect(x.state.pendingMessages(x.lane.address)).toHaveLength(0); expect(x.fileCount()).toBe(1);
  });

  for (const fault of ["module", "index"] as const) {
    it(`recovers the original archived message after ${fault} interruption and never delivers to a reused address`, async () => {
      const x = setup(); const { saved } = x.saveReply(); const first = worker(x);
      if (fault === "module") {
        vi.spyOn(x.store, "updateDeliveryHandoff").mockImplementationOnce(() => { throw new Error("module interrupted"); });
        await expect(first.flush()).rejects.toThrow("module interrupted");
      } else {
        vi.spyOn(x.state, "insertMessage").mockImplementationOnce(() => { throw new Error("index interrupted"); });
        await first.flush();
      }
      await first.close(); const replacement = x.archiveAndReplace();
      expect(replacement.id).not.toBe(saved.ownerLaneId);
      x.reopen();
      const archived = x.state.archivedMessagesForLane(saved.ownerLaneId);
      expect(archived).toHaveLength(1);
      const original = archived[0]!;
      expect(x.state.archivedMessage(original.id)?.targetLaneId).toBe(saved.ownerLaneId);
      expect(x.mailbox.readBody(original.relativePath)).toBe(saved.body);
      x.setTime(x.store.delivery(saved.id)!.nextAttemptAt);
      const deliver = vi.spyOn(x.core, "deliverUserMessage"); await worker(x).flush();
      expect(deliver).toHaveBeenCalledExactlyOnceWith({ target: { laneId: saved.ownerLaneId }, source: { kind: saved.sourceKind, origin: saved.sourceOrigin }, body: saved.body, requestKey: saved.requestKey });
      expect(x.store.delivery(saved.id)).toMatchObject({ handoffState: "accepted", coreMessageId: original.id, lastTargetState: "archived", processedAt: null });
      expect(x.state.pendingMessages(replacement.address)).toHaveLength(0); expect(x.fileCount()).toBe(1);
    });
  }
});
