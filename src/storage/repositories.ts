import {
  acknowledgeDelivery,
  claimDelivery,
  type Delivery,
} from "../core/delivery-state.js";
import type { AckOutcome, PendingDelivery } from "../core/model.js";
import { inTransaction, type RouterDatabase } from "./database.js";
import { canonicalJson } from "./operation-store.js";

export interface RepositoryFaults {
  readonly afterMessageInsert?: () => void;
  readonly afterAckInsert?: () => void;
}

export interface CreateMessageInput {
  readonly messageId: string;
  readonly deliveryId: string;
  readonly senderBindingId: string;
  readonly targetLaneId: string;
  readonly kind: "normal" | "correction";
  readonly body: string;
  readonly metadata: unknown;
  readonly replyTo: string | null;
  readonly createdAt: number;
}

export interface CreateClaimInput {
  readonly claimId: string;
  readonly deliveryId: string;
  readonly generation: number;
  readonly leaseDeadlineAt: number;
  readonly createdAt: number;
}

export interface AcknowledgeInput {
  readonly deliveryId: string;
  readonly claimId: string;
  readonly generation: number;
  readonly outcome: AckOutcome;
  readonly acknowledgedAt: number;
}

interface DeliveryRow {
  readonly id: string;
  readonly target_lane_id: string;
  readonly sequence: number;
  readonly kind: "normal" | "correction";
  readonly state: Delivery["status"];
  readonly failure_count: number;
  readonly deadline_kind: "claim" | "queue" | "lease" | null;
  readonly deadline_at: number | null;
  readonly next_attempt_at: number | null;
  readonly adapter_result: "started_new_turn" | "applied_current_turn" | "queued_next_turn" | null;
  readonly park_reason: string | null;
}

export class StorageRepositories {
  constructor(
    private readonly database: RouterDatabase,
    private readonly faults: RepositoryFaults = {},
  ) {}

  createMessageWithInitialDelivery(input: CreateMessageInput): PendingDelivery {
    return inTransaction(this.database, () => {
      const sequence = (this.database.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM delivery WHERE target_lane_id = ?
      `).get(input.targetLaneId) as { sequence: number }).sequence;

      this.database.prepare(`
        INSERT INTO message (
          id, sender_binding_id, target_lane_id, kind, body, metadata_json,
          reply_to, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.messageId,
        input.senderBindingId,
        input.targetLaneId,
        input.kind,
        input.body,
        canonicalJson(input.metadata),
        input.replyTo,
        input.createdAt,
      );
      this.faults.afterMessageInsert?.();
      this.database.prepare(`
        INSERT INTO delivery (
          id, message_id, target_lane_id, sequence, state, failure_count,
          deadline_kind, deadline_at, next_attempt_at, last_error,
          adapter_result, park_reason, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?)
      `).run(
        input.deliveryId,
        input.messageId,
        input.targetLaneId,
        sequence,
        input.createdAt,
      );
      return {
        id: input.deliveryId,
        targetLaneId: input.targetLaneId,
        sequence,
        kind: input.kind,
        failureCount: 0,
        status: "pending",
        nextAttemptAt: null,
      };
    });
  }

  createClaim(input: CreateClaimInput): Delivery {
    return inTransaction(this.database, () => {
      const current = this.readDelivery(input.deliveryId);
      const claimed = claimDelivery(current, {
        claimId: input.claimId,
        bindingGeneration: input.generation,
        currentGeneration: input.generation,
        now: input.createdAt,
        leaseDeadlineAt: input.leaseDeadlineAt,
      });
      this.database.prepare(`
        INSERT INTO claim (id, delivery_id, generation, lease_deadline_at, created_at, closed_at, close_reason)
        VALUES (?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        input.claimId,
        input.deliveryId,
        input.generation,
        input.leaseDeadlineAt,
        input.createdAt,
      );
      this.persistDelivery(claimed, input.createdAt);
      this.recordEvent("claim_created", input.deliveryId, input.claimId, input.createdAt, {
        generation: input.generation,
        leaseDeadlineAt: input.leaseDeadlineAt,
      });
      return claimed;
    });
  }

  acknowledge(input: AcknowledgeInput): Delivery {
    return inTransaction(this.database, () => {
      const current = this.readDelivery(input.deliveryId);
      const acknowledged = acknowledgeDelivery(current, {
        claimId: input.claimId,
        bindingGeneration: input.generation,
        currentGeneration: input.generation,
        now: input.acknowledgedAt,
        outcome: input.outcome,
      });
      this.database.prepare(`
        INSERT INTO ack (
          delivery_id, claim_id, generation, outcome_kind,
          outcome_payload_json, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.deliveryId,
        input.claimId,
        input.generation,
        input.outcome.kind,
        canonicalJson(input.outcome),
        input.acknowledgedAt,
      );
      this.faults.afterAckInsert?.();
      this.database.prepare(`
        UPDATE claim SET closed_at = ?, close_reason = 'acknowledged'
        WHERE id = ? AND closed_at IS NULL
      `).run(input.acknowledgedAt, input.claimId);
      this.persistDelivery(acknowledged, input.acknowledgedAt);
      this.recordEvent("delivery_acknowledged", input.deliveryId, input.claimId, input.acknowledgedAt, {
        generation: input.generation,
        outcomeKind: input.outcome.kind,
      });
      return acknowledged;
    });
  }

  readDelivery(deliveryId: string): Delivery {
    const row = this.database.prepare(`
      SELECT d.*, m.kind FROM delivery d
      JOIN message m ON m.id = d.message_id
      WHERE d.id = ?
    `).get(deliveryId) as DeliveryRow | undefined;
    if (row === undefined) {
      throw new Error(`Delivery ${deliveryId} does not exist`);
    }
    return deliveryFromRow(row, this.database);
  }

  private persistDelivery(delivery: Delivery, updatedAt: number): void {
    const deadlineKind = delivery.status === "notified"
      ? delivery.notificationKind
      : delivery.status === "claimed" ? "lease" : null;
    const deadlineAt = delivery.status === "notified"
      ? delivery.deadlineAt
      : delivery.status === "claimed" ? delivery.leaseDeadlineAt : null;
    this.database.prepare(`
      UPDATE delivery SET state = ?, failure_count = ?, deadline_kind = ?,
        deadline_at = ?, next_attempt_at = ?, adapter_result = ?, park_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(
      delivery.status,
      delivery.failureCount,
      deadlineKind,
      deadlineAt,
      delivery.status === "pending" ? delivery.nextAttemptAt : null,
      delivery.status === "notified" ? delivery.adapterResult : null,
      delivery.status === "parked" ? delivery.reason : null,
      updatedAt,
      delivery.id,
    );
  }

  private recordEvent(
    eventType: string,
    deliveryId: string,
    claimId: string | null,
    occurredAt: number,
    details: unknown,
  ): void {
    this.database.prepare(`
      INSERT INTO event (event_type, binding_id, delivery_id, claim_id, occurred_at, details_json)
      VALUES (?, NULL, ?, ?, ?, ?)
    `).run(eventType, deliveryId, claimId, occurredAt, canonicalJson(details));
  }
}

function deliveryFromRow(row: DeliveryRow, database: RouterDatabase): Delivery {
  const identity = {
    id: row.id,
    targetLaneId: row.target_lane_id,
    sequence: row.sequence,
    kind: row.kind,
    failureCount: row.failure_count,
  } as const;
  switch (row.state) {
    case "pending":
      return { ...identity, status: "pending", nextAttemptAt: row.next_attempt_at };
    case "notified":
      if (row.deadline_kind === null || row.deadline_kind === "lease" || row.deadline_at === null || row.adapter_result === null) {
        throw new Error(`Delivery ${row.id} has an invalid notified representation`);
      }
      return {
        ...identity,
        status: "notified",
        notificationKind: row.deadline_kind,
        deadlineAt: row.deadline_at,
        adapterResult: row.adapter_result,
      };
    case "claimed": {
      const claim = database.prepare(`
        SELECT id, generation, lease_deadline_at FROM claim
        WHERE delivery_id = ? AND closed_at IS NULL
      `).get(row.id) as { id: string; generation: number; lease_deadline_at: number } | undefined;
      if (claim === undefined) throw new Error(`Delivery ${row.id} has no active claim`);
      return {
        ...identity,
        status: "claimed",
        claimId: claim.id,
        bindingGeneration: claim.generation,
        leaseDeadlineAt: claim.lease_deadline_at,
      };
    }
    case "acknowledged": {
      const ack = database.prepare(`
        SELECT claim_id, generation, outcome_payload_json, acknowledged_at
        FROM ack WHERE delivery_id = ?
      `).get(row.id) as { claim_id: string; generation: number; outcome_payload_json: string; acknowledged_at: number } | undefined;
      if (ack === undefined) throw new Error(`Delivery ${row.id} has no acknowledgement`);
      return {
        ...identity,
        status: "acknowledged",
        claimId: ack.claim_id,
        bindingGeneration: ack.generation,
        outcome: JSON.parse(ack.outcome_payload_json) as AckOutcome,
        acknowledgedAt: ack.acknowledged_at,
      };
    }
    case "parked":
      if (row.park_reason === null) throw new Error(`Delivery ${row.id} has no park reason`);
      return { ...identity, status: "parked", reason: row.park_reason };
  }
}
