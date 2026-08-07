import { expireClaim, expireNotification, type Delivery } from "../core/delivery-state.js";
import { inTransaction, type RouterDatabase } from "./database.js";
import { canonicalJson } from "./operation-store.js";

export interface RecoveryConfig {
  readonly now: number;
  readonly failureLimit: number;
  readonly retryDelay: (failureCount: number) => number;
}

export interface RecoveryResult {
  readonly recovered: number;
  readonly parked: number;
}

interface ExpiredRow {
  readonly id: string;
  readonly target_lane_id: string;
  readonly sequence: number;
  readonly kind: "normal" | "correction";
  readonly state: "notified" | "claimed";
  readonly failure_count: number;
  readonly deadline_kind: "claim" | "queue" | "lease";
  readonly deadline_at: number;
  readonly adapter_result: "started_new_turn" | "applied_current_turn" | "queued_next_turn" | null;
  readonly claim_id: string | null;
  readonly generation: number | null;
  readonly lease_deadline_at: number | null;
}

export function recoverDatabase(
  database: RouterDatabase,
  config: RecoveryConfig,
): RecoveryResult {
  return inTransaction(database, () => {
    const rows = database.prepare(`
      SELECT d.id, d.target_lane_id, d.sequence, m.kind, d.state,
        d.failure_count, d.deadline_kind, d.deadline_at, d.adapter_result,
        c.id AS claim_id, c.generation, c.lease_deadline_at
      FROM delivery d
      JOIN message m ON m.id = d.message_id
      LEFT JOIN claim c ON c.delivery_id = d.id AND c.closed_at IS NULL
      WHERE (d.state = 'notified' AND d.deadline_at <= ?)
        OR (d.state = 'claimed' AND c.lease_deadline_at <= ?)
      ORDER BY d.target_lane_id, d.sequence
    `).all(config.now, config.now) as ExpiredRow[];

    let parked = 0;
    for (const row of rows) {
      const current = hydrateExpiredDelivery(row);
      const failureCountAfterExpiry = row.failure_count + 1;
      const nextAttemptAt = current.status === "notified" && current.notificationKind === "queue"
        ? config.now
        : config.now + config.retryDelay(failureCountAfterExpiry);
      const recovered = current.status === "notified"
        ? expireNotification(current, {
            now: config.now,
            failureLimit: config.failureLimit,
            nextAttemptAt,
          })
        : expireClaim(current, {
            now: config.now,
            failureLimit: config.failureLimit,
            nextAttemptAt,
          });

      if (current.status === "claimed") {
        database.prepare(`
          UPDATE claim SET closed_at = ?, close_reason = 'lease_expired'
          WHERE id = ? AND closed_at IS NULL
        `).run(config.now, current.claimId);
      }
      database.prepare(`
        UPDATE delivery SET state = ?, failure_count = ?, deadline_kind = NULL,
          deadline_at = NULL, next_attempt_at = ?, adapter_result = NULL,
          park_reason = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(
        recovered.status,
        recovered.failureCount,
        recovered.status === "pending" ? recovered.nextAttemptAt : null,
        recovered.status === "parked" ? recovered.reason : null,
        current.status === "claimed" ? "claim lease expired during recovery" : "notification deadline expired during recovery",
        config.now,
        recovered.id,
      );
      database.prepare(`
        INSERT INTO event (event_type, binding_id, delivery_id, claim_id, occurred_at, details_json)
        VALUES (?, NULL, ?, ?, ?, ?)
      `).run(
        recovered.status === "parked" ? "recovery_parked" : "recovery_requeued",
        recovered.id,
        current.status === "claimed" ? current.claimId : null,
        config.now,
        canonicalJson({
          priorState: current.status,
          deadlineKind: row.deadline_kind,
          failureCount: recovered.failureCount,
        }),
      );
      if (recovered.status === "parked") parked += 1;
    }

    return { recovered: rows.length, parked };
  });
}

function hydrateExpiredDelivery(row: ExpiredRow): Delivery {
  const identity = {
    id: row.id,
    targetLaneId: row.target_lane_id,
    sequence: row.sequence,
    kind: row.kind,
    failureCount: row.failure_count,
  } as const;
  if (row.state === "notified") {
    if (row.deadline_kind === "lease" || row.adapter_result === null) {
      throw new Error(`Notified delivery ${row.id} has invalid durable deadline data`);
    }
    return {
      ...identity,
      status: "notified",
      notificationKind: row.deadline_kind,
      deadlineAt: row.deadline_at,
      adapterResult: row.adapter_result,
    };
  }
  if (row.claim_id === null || row.generation === null || row.lease_deadline_at === null) {
    throw new Error(`Claimed delivery ${row.id} has no active durable claim`);
  }
  return {
    ...identity,
    status: "claimed",
    claimId: row.claim_id,
    bindingGeneration: row.generation,
    leaseDeadlineAt: row.lease_deadline_at,
  };
}
