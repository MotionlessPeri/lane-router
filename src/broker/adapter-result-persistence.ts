import type { AdapterResult } from "../core/adapter-contract.js";
import type { Delivery } from "../core/model.js";
import { applyAdapterResult } from "../core/delivery-state.js";
import type { RouterDatabase } from "../storage/database.js";
import { inTransaction } from "../storage/database.js";
import { StorageRepositories } from "../storage/repositories.js";
import { appendEvent } from "./events.js";
import { retryDelay, type RuntimeConfig } from "./runtime.js";

export function persistAdapterResult(input: {
  database: RouterDatabase;
  deliveryIds: readonly string[];
  result: AdapterResult;
  now: () => number;
  random: () => number;
  config: RuntimeConfig;
}): Delivery[] {
  const repositories = new StorageRepositories(input.database);
  return inTransaction(input.database, () => {
    const deliveries = input.deliveryIds.map((deliveryId) => {
      const current = repositories.readDelivery(deliveryId);
      const next = applyAdapterResult(current, input.result, {
        claimDeadlineAt: input.now() + input.config.claimDeadlineMs,
        queueDeadlineAt: input.now() + input.config.queueDeadlineMs,
        failureLimit: input.config.failureLimit,
        nextAttemptAt:
          input.now() + retryDelay(input.config, current.failureCount, input.random),
      });
      persistDelivery(input.database, next, input.now(),
        input.result === "adapter_failed" ? "adapter failed" : null);
      appendEvent(
        input.database,
        "adapter_result",
        input.now(),
        { result: input.result, status: next.status, failureCount: next.failureCount },
        { deliveryId },
      );
      return next;
    });
    const first = deliveries[0];
    if (!first) return deliveries;
    if (input.result === "binding_not_found") {
      const binding = repositories.getCurrentBinding(first.targetLaneId);
      if (binding?.state === "bound")
        repositories.markCurrentBindingUnbound({
          laneId: first.targetLaneId,
          generation: binding.generation,
          occurredAt: input.now(),
          reason: "adapter reported binding not found",
        });
    }
    if (input.result === "stored_pending")
      persistAdapterSuppression({
        database: input.database,
        laneId: first.targetLaneId,
        sourceDeliveryId: first.id,
        reasonCode: "stored_pending",
        now: input.now,
      });
    return deliveries;
  });
}

export function persistAdapterSuppression(input: {
  database: RouterDatabase;
  laneId: string;
  sourceDeliveryId: string | null;
  reasonCode: "stored_pending" | "offline";
  now: () => number;
}): void {
  inTransaction(input.database, () => {
    input.database.prepare(`
      INSERT INTO adapter_suppression(lane_id,source_delivery_id,created_at,reason_code)
      VALUES(?,?,?,?)
      ON CONFLICT(lane_id) DO UPDATE SET
        source_delivery_id=excluded.source_delivery_id,
        created_at=excluded.created_at,
        reason_code=excluded.reason_code
    `).run(input.laneId, input.sourceDeliveryId, input.now(), input.reasonCode);
    appendEvent(
      input.database,
      "adapter_suppressed",
      input.now(),
      { reason: input.reasonCode },
      { laneId: input.laneId },
    );
  });
}

export function clearAdapterSuppression(input: {
  database: RouterDatabase;
  laneId: string;
  now: () => number;
  eventType?: "adapter_reconnected" | "adapter_suppression_cleared";
  reason?: string;
  deliveryId?: string;
}): boolean {
  return inTransaction(input.database, () => {
    const cleared = input.database
      .prepare("DELETE FROM adapter_suppression WHERE lane_id=?")
      .run(input.laneId).changes === 1;
    if (cleared)
      appendEvent(
        input.database,
        input.eventType ?? "adapter_reconnected",
        input.now(),
        input.reason === undefined ? {} : { reason: input.reason },
        { laneId: input.laneId, deliveryId: input.deliveryId },
      );
    return cleared;
  });
}

function persistDelivery(
  database: RouterDatabase,
  delivery: Delivery,
  updatedAt: number,
  error: string | null,
): void {
  const deadlineKind = delivery.status === "notified"
    ? delivery.notificationKind
    : delivery.status === "claimed" ? "lease" : null;
  const deadlineAt = delivery.status === "notified"
    ? delivery.deadlineAt
    : delivery.status === "claimed" ? delivery.leaseDeadlineAt : null;
  database.prepare(`
    UPDATE delivery SET state=?,failure_count=?,deadline_kind=?,deadline_at=?,
      next_attempt_at=?,last_error=?,adapter_result=?,park_reason=?,updated_at=? WHERE id=?
  `).run(
    delivery.status,
    delivery.failureCount,
    deadlineKind,
    deadlineAt,
    delivery.status === "pending" ? delivery.nextAttemptAt : null,
    error,
    delivery.status === "notified" ? delivery.adapterResult : null,
    delivery.status === "parked" ? delivery.reason : null,
    updatedAt,
    delivery.id,
  );
}
