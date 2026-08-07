import { posix, win32 } from "node:path";

import {
  acknowledgeDelivery,
  claimDelivery,
  type Delivery,
} from "../core/delivery-state.js";
import type { AckOutcome, PendingDelivery } from "../core/model.js";
import {
  InvalidDeliveryOperationError,
  StaleBindingGenerationError,
} from "../core/errors.js";
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

export interface CurrentBinding {
  readonly id: string;
  readonly laneId: string;
  readonly workspaceId: string;
  readonly adapter: "claude" | "codex";
  readonly conversationId: string;
  readonly generation: number;
  readonly state: "bound" | "unbound";
}

export interface MarkBindingUnboundInput {
  readonly laneId: string;
  readonly generation: number;
  readonly occurredAt: number;
  readonly reason: string;
}

export interface RebuildBindingInput {
  readonly bindingId: string;
  readonly laneId: string;
  readonly workspaceId: string;
  readonly adapter: "claude" | "codex";
  readonly conversationId: string;
  readonly activatedAt: number;
  readonly reason: string;
}

interface CurrentBindingRow {
  readonly id: string;
  readonly lane_id: string;
  readonly workspace_id: string;
  readonly adapter: "claude" | "codex";
  readonly conversation_id: string;
  readonly generation: number;
  readonly state: "bound" | "unbound";
}

export class InvalidAckOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
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
      const binding = this.requireCurrentBoundBindingForDelivery(
        input.deliveryId,
        input.generation,
        "claim_delivery",
      );
      const claimed = claimDelivery(current, {
        claimId: input.claimId,
        bindingGeneration: input.generation,
        currentGeneration: binding.generation,
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
      const binding = this.requireCurrentBoundBindingForDelivery(
        input.deliveryId,
        input.generation,
        "acknowledge_delivery",
      );
      const normalizedOutcome = this.validateAndNormalizeAckOutcome(
        input.deliveryId,
        input.outcome,
      );
      const acknowledged = acknowledgeDelivery(current, {
        claimId: input.claimId,
        bindingGeneration: input.generation,
        currentGeneration: binding.generation,
        now: input.acknowledgedAt,
        outcome: normalizedOutcome,
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
        normalizedOutcome.kind,
        canonicalJson(normalizedOutcome),
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
        outcomeKind: normalizedOutcome.kind,
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

  getCurrentBinding(laneId: string): CurrentBinding | null {
    const row = this.database.prepare(`
      SELECT id, lane_id, workspace_id, adapter, conversation_id, generation, state
      FROM binding WHERE lane_id = ? AND is_current = 1
    `).get(laneId) as CurrentBindingRow | undefined;
    return row === undefined ? null : bindingFromRow(row);
  }

  markCurrentBindingUnbound(input: MarkBindingUnboundInput): CurrentBinding {
    return inTransaction(this.database, () => {
      const current = this.requireCurrentBinding(input.laneId);
      this.assertBindingGeneration("mark_binding_unbound", input.generation, current.generation);
      if (current.state !== "bound") {
        throw new InvalidDeliveryOperationError(
          "mark_binding_unbound",
          `Current binding for lane ${input.laneId} is already ${current.state}`,
        );
      }
      const reason = normalizeBindingReason(input.reason, "mark_binding_unbound");
      this.database.prepare(`
        UPDATE binding SET state = 'unbound', state_changed_at = ?, state_reason = ?
        WHERE id = ?
      `).run(input.occurredAt, reason, current.id);
      this.recordBindingEvent("binding_unbound", current.id, input.occurredAt, {
        generation: current.generation,
        reason,
      });
      return { ...current, state: "unbound" };
    });
  }

  rebuildBinding(input: RebuildBindingInput): CurrentBinding {
    return inTransaction(this.database, () => {
      const current = this.requireCurrentBinding(input.laneId);
      if (current.state !== "unbound") {
        throw new InvalidDeliveryOperationError(
          "rebuild_binding",
          "A binding can only be rebuilt after it becomes unbound",
        );
      }
      const reason = normalizeBindingReason(input.reason, "rebuild_binding");
      const generation = (this.database.prepare(`
        SELECT COALESCE(MAX(generation), 0) + 1 AS generation
        FROM binding WHERE lane_id = ?
      `).get(input.laneId) as { generation: number }).generation;
      this.database.prepare(`
        UPDATE binding SET is_current = 0, inactive_at = ?, inactive_reason = ?
        WHERE id = ?
      `).run(input.activatedAt, reason, current.id);
      this.database.prepare(`
        INSERT INTO binding (
          id, lane_id, workspace_id, adapter, conversation_id, generation,
          active_at, inactive_at, inactive_reason, is_current,
          state, state_changed_at, state_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, 'bound', NULL, NULL)
      `).run(
        input.bindingId,
        input.laneId,
        input.workspaceId,
        input.adapter,
        input.conversationId,
        generation,
        input.activatedAt,
      );
      this.recordBindingEvent("binding_rebuilt", input.bindingId, input.activatedAt, {
        previousBindingId: current.id,
        generation,
        reason,
      });
      return {
        id: input.bindingId,
        laneId: input.laneId,
        workspaceId: input.workspaceId,
        adapter: input.adapter,
        conversationId: input.conversationId,
        generation,
        state: "bound",
      };
    });
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

  private requireCurrentBoundBindingForDelivery(
    deliveryId: string,
    generation: number,
    operation: "claim_delivery" | "acknowledge_delivery",
  ): CurrentBinding {
    const row = this.database.prepare(`
      SELECT b.id, b.lane_id, b.workspace_id, b.adapter, b.conversation_id,
        b.generation, b.state
      FROM delivery d
      JOIN binding b ON b.lane_id = d.target_lane_id AND b.is_current = 1
      WHERE d.id = ?
    `).get(deliveryId) as CurrentBindingRow | undefined;
    if (row === undefined) {
      throw new InvalidDeliveryOperationError(operation, `Delivery ${deliveryId} has no current binding`);
    }
    this.assertBindingGeneration(operation, generation, row.generation);
    if (row.state !== "bound") {
      throw new InvalidDeliveryOperationError(operation, `Current binding ${row.id} is unbound`);
    }
    return bindingFromRow(row);
  }

  private requireCurrentBinding(laneId: string): CurrentBinding {
    const current = this.getCurrentBinding(laneId);
    if (current === null) {
      throw new InvalidDeliveryOperationError(
        "rebuild_binding",
        `Lane ${laneId} has no current binding`,
      );
    }
    return current;
  }

  private assertBindingGeneration(
    operation: "claim_delivery" | "acknowledge_delivery" | "mark_binding_unbound",
    provided: number,
    current: number,
  ): void {
    if (provided !== current) {
      throw new StaleBindingGenerationError(operation, provided, current);
    }
  }

  private validateAndNormalizeAckOutcome(
    deliveryId: string,
    outcome: AckOutcome,
  ): AckOutcome {
    switch (outcome.kind) {
      case "replied": {
        const relation = this.database.prepare(`
          SELECT reply.reply_to, original.message_id AS original_message_id
          FROM delivery original
          LEFT JOIN message reply ON reply.id = ?
          WHERE original.id = ?
        `).get(outcome.replyMessageId, deliveryId) as {
          reply_to: string | null;
          original_message_id: string;
        } | undefined;
        if (relation === undefined || relation.reply_to !== relation.original_message_id) {
          throw new InvalidAckOutcomeError("Reply message must exist and reply to the acknowledged message");
        }
        return { kind: "replied", replyMessageId: outcome.replyMessageId };
      }
      case "recorded": {
        const summary = requireNonEmpty(outcome.summary, "Recorded summary");
        const documentPath = outcome.documentPath === undefined
          ? undefined
          : normalizeProjectRelativePath(outcome.documentPath);
        const externalTaskId = outcome.externalTaskId === undefined
          ? undefined
          : requireNonEmpty(outcome.externalTaskId, "External task ID");
        return {
          kind: "recorded",
          summary,
          ...(documentPath === undefined ? {} : { documentPath }),
          ...(externalTaskId === undefined ? {} : { externalTaskId }),
        };
      }
      case "rejected":
        return { kind: "rejected", reason: requireNonEmpty(outcome.reason, "Rejection reason") };
    }
  }

  private recordBindingEvent(
    eventType: string,
    bindingId: string,
    occurredAt: number,
    details: unknown,
  ): void {
    this.database.prepare(`
      INSERT INTO event (event_type, binding_id, delivery_id, claim_id, occurred_at, details_json)
      VALUES (?, ?, NULL, NULL, ?, ?)
    `).run(eventType, bindingId, occurredAt, canonicalJson(details));
  }
}

function bindingFromRow(row: CurrentBindingRow): CurrentBinding {
  return {
    id: row.id,
    laneId: row.lane_id,
    workspaceId: row.workspace_id,
    adapter: row.adapter,
    conversationId: row.conversation_id,
    generation: row.generation,
    state: row.state,
  };
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new InvalidAckOutcomeError(`${label} must not be empty`);
  return normalized;
}

function normalizeBindingReason(
  value: string,
  operation: "mark_binding_unbound" | "rebuild_binding",
): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new InvalidDeliveryOperationError(operation, "Binding lifecycle reason must not be empty");
  }
  return normalized;
}

function normalizeProjectRelativePath(value: string): string {
  const normalized = requireNonEmpty(value, "Document path");
  if (
    win32.isAbsolute(normalized) ||
    posix.isAbsolute(normalized) ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    throw new InvalidAckOutcomeError("Document path must be project-relative");
  }
  if (normalized.split(/[\\/]/u).includes("..")) {
    throw new InvalidAckOutcomeError("Document path must not traverse outside the project");
  }
  return normalized;
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
