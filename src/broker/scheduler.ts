import type { AdapterResult, DeliveryAdapter } from "../core/adapter-contract.js";
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
  readonly onFatal?: (error: SchedulerFatalError) => void;
}
interface EligibleRow {
  id: string;
  message_id: string;
  target_lane_id: string;
  sequence: number;
  kind: "normal" | "correction";
  generation: number;
  adapter: "claude" | "codex";
  state: Delivery["status"];
  next_attempt_at: number | null;
  deadline_kind: "claim" | "queue" | "lease" | null;
}

export const SCHEDULER_UNRESOLVED_SQL = `
  SELECT d.id,d.message_id,d.target_lane_id,d.sequence,m.kind,b.generation,
    b.adapter,d.state,d.next_attempt_at,d.deadline_kind
  FROM delivery d
  JOIN message m ON m.id=d.message_id
  JOIN binding b ON b.lane_id=d.target_lane_id AND b.is_current=1
  WHERE d.state NOT IN ('acknowledged','parked')
    AND b.state='bound'
    AND NOT EXISTS (
      SELECT 1 FROM dispatch_fence f
      WHERE f.delivery_id=d.id AND f.resolved_at IS NULL
    )
  ORDER BY d.target_lane_id,d.sequence
`;

export class Scheduler {
  private readonly repositories: StorageRepositories;
  private readonly busy = new Set<string>();
  private readonly running = new Set<string>();
  private readonly unavailable = new Set<string>();
  private readonly storedPending = new Set<string>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onFatal: (error: SchedulerFatalError) => void;
  private fatal: SchedulerFatalError | null = null;
  constructor(
    private readonly database: RouterDatabase,
    private readonly adapters: AdapterRegistry,
    private readonly config: RuntimeConfig,
    dependencies: SchedulerDependencies = {},
  ) {
    this.repositories = new StorageRepositories(database);
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.onFatal = dependencies.onFatal ?? (() => undefined);
  }
  setLaneBusy(laneId: string, busy: boolean): void {
    if (busy) this.busy.add(laneId);
    else this.busy.delete(laneId);
  }
  setLaneAvailable(laneId: string, available: boolean): void {
    if (available) {
      this.unavailable.delete(laneId);
      this.storedPending.delete(laneId);
    } else this.unavailable.add(laneId);
  }

  turnEndedBeforeClaim(deliveryId: string): Delivery {
    const current = this.repositories.readDelivery(deliveryId);
    const failed = recordStartedTurnEndedBeforeClaim(current, {
      failureLimit: this.config.failureLimit,
      nextAttemptAt:
        this.now() + retryDelay(this.config, current.failureCount, this.random),
    });
    inTransaction(this.database, () => {
      this.persist(failed, "started turn ended before claim");
      appendEvent(
        this.database,
        "turn_ended_before_claim",
        this.now(),
        { status: failed.status, failureCount: failed.failureCount },
        { deliveryId },
      );
    });
    this.busy.delete(current.targetLaneId);
    return failed;
  }

  async runOnce(): Promise<number> {
    if (this.fatal) throw this.fatal;
    recoverDatabase(this.database, {
      now: this.now(),
      failureLimit: this.config.failureLimit,
      retryDelay: (attempt) => retryDelay(this.config, attempt, this.random),
    });
    const rows = this.database
      .prepare(SCHEDULER_UNRESOLVED_SQL)
      .all() as EligibleRow[];
    const groups = new Map<string, EligibleRow[]>();
    for (const row of rows) {
      const current = groups.get(row.target_lane_id) ?? [];
      current.push(row);
      groups.set(row.target_lane_id, current);
    }
    const laneResults = await Promise.allSettled(
      [...groups.entries()].map(async ([laneId, candidates]) => {
        if (this.running.has(laneId)) return;
        this.running.add(laneId);
        try {
          const adapter = this.adapters[candidates[0]!.adapter];
          let runtime: Awaited<ReturnType<DeliveryAdapter["getRuntimeState"]>>;
          try {
            runtime = await adapter.getRuntimeState({
              targetLaneId: laneId,
              bindingGeneration: candidates[0]!.generation,
            });
          } catch {
            this.unavailable.add(laneId);
            appendEvent(
              this.database,
              "adapter_runtime_state_failed",
              this.now(),
              { availability: "degraded" },
            );
            return;
          }
          if (runtime.availability !== "online") {
            this.unavailable.add(laneId);
            return;
          }
          this.unavailable.delete(laneId);
          if (this.unavailable.has(laneId) || this.storedPending.has(laneId))
            return;
          const durableTurn = candidates.some(
            (row) => row.state === "notified" || row.state === "claimed",
          );
          const ended =
            runtime.turn === "idle" &&
            candidates.find(
              (row) =>
                row.state === "notified" && row.deadline_kind === "claim",
            );
          if (ended) {
            this.turnEndedBeforeClaim(ended.id);
            return;
          }
          const busy =
            this.busy.has(laneId) || runtime.turn === "busy" || durableTurn;
          const corrections = candidates.filter(
            (row) => row.kind === "correction",
          );
          const normals = candidates.filter((row) => row.kind === "normal");
          const selected = this.eligiblePrefix(corrections).length
            ? this.eligiblePrefix(corrections)
            : busy
              ? []
              : this.eligiblePrefix(normals);
          if (!selected.length) return;
          await this.deliverBatch(selected);
        } finally {
          this.running.delete(laneId);
        }
      }),
    );
    const failures = laneResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, "One or more scheduler lanes failed");
    return groups.size;
  }

  private eligiblePrefix(rows: EligibleRow[]): EligibleRow[] {
    const selected: EligibleRow[] = [];
    for (const row of rows) {
      if (
        row.state !== "pending" ||
        (row.next_attempt_at !== null && row.next_attempt_at > this.now())
      )
        break;
      selected.push(row);
    }
    return selected;
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
    try {
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
    } catch (persistenceError) {
      try {
        this.persistDispatchFences(rows, result);
      } catch (fenceError) {
        this.markFatal(persistenceError, fenceError);
      }
      throw persistenceError;
    }
    if (result === "started_new_turn") this.busy.add(first.target_lane_id);
    if (result === "stored_pending")
      this.storedPending.add(first.target_lane_id);
  }
  private persistDispatchFences(rows: EligibleRow[], result: AdapterResult): void {
    inTransaction(this.database, () => {
      const statement = this.database.prepare(`
        INSERT INTO dispatch_fence(
          delivery_id,lane_id,adapter_outcome,fenced_at,reason_code
        ) VALUES(?,?,?,?,'post_adapter_persistence_failed')
      `);
      for (const row of rows)
        statement.run(row.id, row.target_lane_id, result, this.now());
    });
  }
  private markFatal(persistenceError: unknown, fenceError: unknown): never {
    this.fatal = new SchedulerFatalError(persistenceError, fenceError);
    try {
      this.onFatal(this.fatal);
    } catch {
      /* fatal state is retained even if its observer fails */
    }
    throw this.fatal;
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

export class SchedulerFatalError extends Error {
  readonly code = "SCHEDULER_FATAL";
  constructor(
    readonly persistenceError: unknown,
    readonly fenceError: unknown,
  ) {
    super(`Scheduler fenced after dispatch fence persistence failed: ${errorMessage(fenceError)}`);
    this.name = new.target.name;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
