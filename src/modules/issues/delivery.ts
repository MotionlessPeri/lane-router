import type { UserMessageDelivery, UserMessageResult } from "../../router/user-message.js";
import type { IssueStore } from "./ports.js";
import type { IssueDelivery } from "./types.js";

const POLL_INTERVAL_MS = 1_000;
const MAX_RETRY_INTERVAL_MS = 60_000;
const BATCH_SIZE = 32;

export interface IssueDeliveryWorkerOptions {
  readonly store: Pick<IssueStore, "pendingDeliveries" | "updateDeliveryHandoff">;
  readonly delivery: UserMessageDelivery;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export class IssueDeliveryWorker {
  private readonly now: () => number;
  private started = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly options: IssueDeliveryWorkerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Recover due work immediately; imports and construction never start timers. */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Issue delivery worker is closed"));
    if (this.started) return this.inFlight ?? Promise.resolve();
    this.started = true;
    return this.tick();
  }

  /** A single due batch, shared by every caller while it is in flight. */
  flush(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Issue delivery worker is closed"));
    if (!this.inFlight) {
      // Install the guard before any port can call back or yield.
      this.inFlight = Promise.resolve().then(() => this.deliverBatch()).finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.started = false;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    await this.inFlight;
  }

  private tick(): Promise<void> {
    return this.flush().finally(() => {
      if (!this.started || this.closed) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.tick().catch((error: unknown) => this.report(error));
      }, POLL_INTERVAL_MS);
    });
  }

  private async deliverBatch(): Promise<void> {
    const due = this.options.store.pendingDeliveries(this.now(), BATCH_SIZE);
    for (const record of due) {
      if (this.closed) break;
      await this.deliver(record);
    }
  }

  private async deliver(record: IssueDelivery): Promise<void> {
    const attemptCount = record.attemptCount + 1;
    let result: UserMessageResult;
    try {
      // Core owns file/index recovery, including a successful original whose lane is now archived.
      result = await this.options.delivery.deliverUserMessage({
        target: { laneId: record.ownerLaneId },
        source: { kind: record.sourceKind, origin: record.sourceOrigin },
        body: record.body, requestKey: record.requestKey,
      });
      if (result.delivered && !result.messageId) throw new Error("Core accepted issue delivery without a message ID");
    } catch (error) {
      const delay = Math.min(MAX_RETRY_INTERVAL_MS, POLL_INTERVAL_MS * 2 ** Math.min(attemptCount - 1, 6));
      this.options.store.updateDeliveryHandoff(record.id, {
        handoffState: "pending", coreMessageId: null, attemptCount, nextAttemptAt: this.now() + delay,
        lastError: error instanceof Error ? error.message : String(error), lastTargetState: record.lastTargetState,
      });
      return;
    }
    // Keep this write outside the delivery catch. If it fails, the original pending record and key
    // must survive; the caller sees the storage error and a later pass recovers the same core ID.
    this.options.store.updateDeliveryHandoff(record.id, {
      handoffState: result.delivered ? "accepted" : "blocked", coreMessageId: result.messageId,
      attemptCount, nextAttemptAt: this.now(), lastTargetState: result.target.state,
      lastError: result.delivered ? null : `Core refused issue delivery: ${result.target.state}`,
    });
  }

  private report(error: unknown): void {
    try { (this.options.onError ?? console.error)(error); }
    catch (reportError) { console.error("Issue delivery error reporter failed", reportError, error); }
  }
}
