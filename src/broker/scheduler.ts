import type { DeliveryAdapter } from "../core/adapter-contract.js";
import {
  applyAdapterResult,
  recordStartedTurnEndedBeforeClaim,
  type Delivery,
} from "../core/delivery-state.js";
import type { RouterDatabase } from "../storage/database.js";
import { inTransaction } from "../storage/database.js";
import { StorageRepositories } from "../storage/repositories.js";
import { recoverDatabase } from "../storage/recovery.js";
import { appendEvent } from "./events.js";
import { retryDelay, type RuntimeConfig } from "./runtime.js";

export type AdapterRegistry = Readonly<{
  claude: DeliveryAdapter;
  codex: DeliveryAdapter;
}>;
interface SchedulerDependencies {
  readonly now?: () => number;
  readonly random?: () => number;
}
interface EligibleRow {
  id: string;
  message_id: string;
  target_lane_id: string;
  sequence: number;
  kind: "normal" | "correction";
  generation: number;
  adapter: "claude" | "codex";
}

export class Scheduler {
  private readonly repositories: StorageRepositories;
  private readonly busy = new Set<string>();
  private readonly running = new Set<string>();
  private readonly now: () => number;
  private readonly random: () => number;
  constructor(
    private readonly database: RouterDatabase,
    private readonly adapters: AdapterRegistry,
    private readonly config: RuntimeConfig,
    dependencies: SchedulerDependencies = {},
  ) {
    this.repositories = new StorageRepositories(database);
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
  }
  setLaneBusy(laneId: string, busy: boolean): void {
    if (busy) this.busy.add(laneId);
    else this.busy.delete(laneId);
  }

  turnEndedBeforeClaim(deliveryId: string): Delivery {
    const current = this.repositories.readDelivery(deliveryId);
    const failed = recordStartedTurnEndedBeforeClaim(current, {
      failureLimit: this.config.failureLimit,
      nextAttemptAt:
        this.now() + retryDelay(this.config, current.failureCount, this.random),
    });
    this.persist(failed, "started turn ended before claim");
    this.busy.delete(current.targetLaneId);
    appendEvent(
      this.database,
      "turn_ended_before_claim",
      this.now(),
      { status: failed.status, failureCount: failed.failureCount },
      { deliveryId },
    );
    return failed;
  }

  async runOnce(): Promise<number> {
    recoverDatabase(this.database, {
      now: this.now(),
      failureLimit: this.config.failureLimit,
      retryDelay: (attempt) => retryDelay(this.config, attempt, this.random),
    });
    const rows = this.database
      .prepare(
        `SELECT d.id,d.message_id,d.target_lane_id,d.sequence,m.kind,b.generation,b.adapter FROM delivery d JOIN message m ON m.id=d.message_id JOIN binding b ON b.lane_id=d.target_lane_id AND b.is_current=1 WHERE d.state='pending' AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?) AND b.state='bound' ORDER BY d.target_lane_id,CASE m.kind WHEN 'correction' THEN 0 ELSE 1 END,d.sequence`,
      )
      .all(this.now()) as EligibleRow[];
    const groups = new Map<string, EligibleRow[]>();
    for (const row of rows) {
      const current = groups.get(row.target_lane_id) ?? [];
      current.push(row);
      groups.set(row.target_lane_id, current);
    }
    await Promise.all(
      [...groups.entries()].map(async ([laneId, candidates]) => {
        if (this.running.has(laneId)) return;
        const corrections = candidates.filter(
          (row) => row.kind === "correction",
        );
        const selected = corrections.length
          ? corrections
          : this.busy.has(laneId)
            ? []
            : candidates.filter((row) => row.kind === "normal");
        if (!selected.length) return;
        this.running.add(laneId);
        try {
          await this.deliverBatch(selected);
        } finally {
          this.running.delete(laneId);
        }
      }),
    );
    return groups.size;
  }

  private async deliverBatch(rows: EligibleRow[]): Promise<void> {
    const first = rows[0]!;
    let result: Awaited<ReturnType<DeliveryAdapter["deliver"]>>;
    try {
      result = await this.adapters[first.adapter].deliver({
        deliveryId: first.id,
        deliveryIds: rows.map((row) => row.id),
        messageId: first.message_id,
        messageIds: rows.map((row) => row.message_id),
        targetLaneId: first.target_lane_id,
        sequence: first.sequence,
        kind: first.kind,
        bindingGeneration: first.generation,
      });
    } catch {
      result = "adapter_failed";
    }
    inTransaction(this.database, () => {
      for (const row of rows) {
        const current = this.repositories.readDelivery(row.id);
        const attempt = current.failureCount;
        const next = applyAdapterResult(current, result, {
          claimDeadlineAt: this.now() + this.config.claimDeadlineMs,
          queueDeadlineAt: this.now() + this.config.queueDeadlineMs,
          failureLimit: this.config.failureLimit,
          nextAttemptAt:
            this.now() + retryDelay(this.config, attempt, this.random),
        });
        this.persist(
          next,
          result === "adapter_failed" ? "adapter failed" : null,
        );
        appendEvent(
          this.database,
          "adapter_result",
          this.now(),
          { result, status: next.status, failureCount: next.failureCount },
          { deliveryId: row.id },
        );
      }
      if (result === "binding_not_found") {
        const binding = this.repositories.getCurrentBinding(
          first.target_lane_id,
        );
        if (binding?.state === "bound")
          this.repositories.markCurrentBindingUnbound({
            laneId: first.target_lane_id,
            generation: binding.generation,
            occurredAt: this.now(),
            reason: "adapter reported binding not found",
          });
      }
    });
    if (result === "started_new_turn") this.busy.add(first.target_lane_id);
  }
  private persist(delivery: Delivery, error: string | null): void {
    const kind =
      delivery.status === "notified"
        ? delivery.notificationKind
        : delivery.status === "claimed"
          ? "lease"
          : null;
    const deadline =
      delivery.status === "notified"
        ? delivery.deadlineAt
        : delivery.status === "claimed"
          ? delivery.leaseDeadlineAt
          : null;
    this.database
      .prepare(
        "UPDATE delivery SET state=?,failure_count=?,deadline_kind=?,deadline_at=?,next_attempt_at=?,last_error=?,adapter_result=?,park_reason=?,updated_at=? WHERE id=?",
      )
      .run(
        delivery.status,
        delivery.failureCount,
        kind,
        deadline,
        delivery.status === "pending" ? delivery.nextAttemptAt : null,
        error,
        delivery.status === "notified" ? delivery.adapterResult : null,
        delivery.status === "parked" ? delivery.reason : null,
        this.now(),
        delivery.id,
      );
  }
}
