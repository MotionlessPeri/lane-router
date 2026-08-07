import type { AdapterResult } from "./adapter-contract.js";
import {
  ClaimExpiredError,
  ClaimMismatchError,
  DeadlineNotExpiredError,
  type DeliveryOperation,
  IllegalDeliveryTransitionError,
  InvalidDeliveryOperationError,
  StaleBindingGenerationError,
} from "./errors.js";
import type {
  AckOutcome,
  AcknowledgedDelivery,
  ClaimedDelivery,
  Delivery,
  DeliveryIdentity,
  DeliveryStatus,
  NotifiedDelivery,
  ParkedDelivery,
  PendingDelivery,
} from "./model.js";

export type { Delivery, DeliveryStatus } from "./model.js";

const LEGAL_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  pending: ["notified", "claimed", "parked"],
  notified: ["pending", "claimed", "parked"],
  claimed: ["pending", "acknowledged", "parked"],
  acknowledged: [],
  parked: ["pending"],
};

export interface AdapterResultContext {
  readonly claimDeadlineAt: number;
  readonly queueDeadlineAt: number;
  readonly failureLimit: number;
  readonly nextAttemptAt: number;
}

export interface FailureContext {
  readonly failureLimit: number;
  readonly nextAttemptAt: number;
}

export interface ExpirationContext extends FailureContext {
  readonly now: number;
}

export interface ClaimInput {
  readonly claimId: string;
  readonly bindingGeneration: number;
  readonly currentGeneration: number;
  readonly now: number;
  readonly leaseDeadlineAt: number;
}

export interface RenewClaimInput extends ClaimInput {}

export interface AcknowledgeInput {
  readonly claimId: string;
  readonly bindingGeneration: number;
  readonly currentGeneration: number;
  readonly now: number;
  readonly outcome: AckOutcome;
}

export function assertLegalDeliveryTransition(
  from: DeliveryStatus,
  to: DeliveryStatus,
): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new IllegalDeliveryTransitionError(from, to);
  }
}

export function applyAdapterResult(
  delivery: Delivery,
  result: AdapterResult,
  context: AdapterResultContext,
): Delivery {
  requireStatus(delivery, "pending", "apply_adapter_result");

  switch (result) {
    case "started_new_turn":
    case "applied_current_turn":
      return notified(delivery, result, "claim", context.claimDeadlineAt);
    case "queued_next_turn":
      return notified(delivery, result, "queue", context.queueDeadlineAt);
    case "stored_pending":
    case "binding_not_found":
      return toPending(delivery, delivery.failureCount, null);
    case "adapter_failed":
      return recordFailure(delivery, context);
  }
}

export function deferDelivery(
  delivery: Delivery,
  _reason: "offline" | "unbound",
): PendingDelivery {
  requireStatus(delivery, "pending", "defer_delivery");
  return toPending(delivery, delivery.failureCount, null);
}

export function expireNotification(
  delivery: Delivery,
  context: ExpirationContext,
): PendingDelivery | ParkedDelivery {
  requireStatus(delivery, "notified", "expire_notification");
  if (context.now < delivery.deadlineAt) {
    throw new DeadlineNotExpiredError(
      "expire_notification",
      context.now,
      delivery.deadlineAt,
    );
  }
  if (delivery.notificationKind === "queue") {
    return toPending(delivery, delivery.failureCount, null);
  }
  return recordFailure(delivery, context);
}

export function recordStartedTurnEndedBeforeClaim(
  delivery: Delivery,
  context: FailureContext,
): PendingDelivery | ParkedDelivery {
  requireStatus(
    delivery,
    "notified",
    "record_started_turn_ended_before_claim",
  );
  if (delivery.notificationKind !== "claim") {
    throw new InvalidDeliveryOperationError(
      "record_started_turn_ended_before_claim",
      "A queued notification does not represent a started turn",
    );
  }
  return recordFailure(delivery, context);
}

export function claimDelivery(delivery: Delivery, input: ClaimInput): ClaimedDelivery {
  if (delivery.status !== "pending" && delivery.status !== "notified") {
    throw new InvalidDeliveryOperationError(
      "claim_delivery",
      `Cannot claim a delivery in ${delivery.status} state`,
    );
  }
  if (delivery.status === "notified" && input.now >= delivery.deadlineAt) {
    throw new InvalidDeliveryOperationError(
      "claim_delivery",
      "Cannot claim after notification expiry",
    );
  }
  assertCurrentGeneration(
    "claim_delivery",
    input.bindingGeneration,
    input.currentGeneration,
  );
  assertValidLeaseDeadline("claim_delivery", input.leaseDeadlineAt, input.now);
  assertLegalDeliveryTransition(delivery.status, "claimed");
  return {
    ...identityOf(delivery),
    status: "claimed",
    claimId: input.claimId,
    bindingGeneration: input.bindingGeneration,
    leaseDeadlineAt: input.leaseDeadlineAt,
  };
}

export function renewClaim(
  delivery: Delivery,
  input: RenewClaimInput,
): ClaimedDelivery {
  requireStatus(delivery, "claimed", "renew_claim");
  assertUsableClaim("renew_claim", delivery, input);
  assertValidLeaseDeadline("renew_claim", input.leaseDeadlineAt, input.now);
  if (input.leaseDeadlineAt < delivery.leaseDeadlineAt) {
    throw new InvalidDeliveryOperationError(
      "renew_claim",
      "A claim renewal cannot shorten the current lease",
      {
        provided: input.leaseDeadlineAt,
        current: delivery.leaseDeadlineAt,
      },
    );
  }
  return {
    ...delivery,
    leaseDeadlineAt: input.leaseDeadlineAt,
  };
}

export function acknowledgeDelivery(
  delivery: Delivery,
  input: AcknowledgeInput,
): AcknowledgedDelivery {
  requireStatus(delivery, "claimed", "acknowledge_delivery");
  assertUsableClaim("acknowledge_delivery", delivery, input);
  assertLegalDeliveryTransition("claimed", "acknowledged");
  return {
    ...identityOf(delivery),
    status: "acknowledged",
    claimId: delivery.claimId,
    bindingGeneration: delivery.bindingGeneration,
    outcome: copyAckOutcome(input.outcome),
    acknowledgedAt: input.now,
  };
}

export function expireClaim(
  delivery: Delivery,
  context: ExpirationContext,
): PendingDelivery | ParkedDelivery {
  requireStatus(delivery, "claimed", "expire_claim");
  if (context.now < delivery.leaseDeadlineAt) {
    throw new DeadlineNotExpiredError(
      "expire_claim",
      context.now,
      delivery.leaseDeadlineAt,
    );
  }
  return recordFailure(delivery, context);
}

export function parkDelivery(delivery: Delivery, reason: string): ParkedDelivery {
  if (delivery.status === "acknowledged" || delivery.status === "parked") {
    throw new InvalidDeliveryOperationError(
      "park_delivery",
      `Cannot park a delivery in ${delivery.status} state`,
    );
  }
  assertLegalDeliveryTransition(delivery.status, "parked");
  return {
    ...identityOf(delivery),
    status: "parked",
    reason,
  };
}

export function unparkDelivery(delivery: Delivery): PendingDelivery {
  requireStatus(delivery, "parked", "unpark_delivery");
  assertLegalDeliveryTransition("parked", "pending");
  return toPending(delivery, delivery.failureCount, null);
}

export function selectNextEligibleDelivery(
  deliveries: readonly Delivery[],
  targetLaneId: string,
  now: number,
): PendingDelivery | NotifiedDelivery | null {
  const laneDeliveries = deliveries.filter(
    (delivery) => delivery.targetLaneId === targetLaneId,
  );
  const unresolvedCorrections = unresolvedInSequence(
    laneDeliveries,
    "correction",
  );
  if (unresolvedCorrections.length > 0) {
    return claimableOrBlocked(unresolvedCorrections[0], now);
  }

  const unresolvedNormals = unresolvedInSequence(laneDeliveries, "normal");
  return unresolvedNormals.length === 0
    ? null
    : claimableOrBlocked(unresolvedNormals[0], now);
}

function notified(
  delivery: PendingDelivery,
  adapterResult: NotifiedDelivery["adapterResult"],
  notificationKind: NotifiedDelivery["notificationKind"],
  deadlineAt: number,
): NotifiedDelivery {
  assertLegalDeliveryTransition("pending", "notified");
  return {
    ...identityOf(delivery),
    status: "notified",
    notificationKind,
    deadlineAt,
    adapterResult,
  };
}

function recordFailure(
  delivery: Delivery,
  context: FailureContext,
): PendingDelivery | ParkedDelivery {
  const failureCount = delivery.failureCount + 1;
  if (failureCount >= context.failureLimit) {
    return {
      ...identityOf(delivery),
      failureCount,
      status: "parked",
      reason: "failure_limit",
    };
  }
  return toPending(delivery, failureCount, context.nextAttemptAt);
}

function toPending(
  delivery: Delivery,
  failureCount: number,
  nextAttemptAt: number | null,
): PendingDelivery {
  return {
    ...identityOf(delivery),
    failureCount,
    status: "pending",
    nextAttemptAt,
  };
}

function identityOf(delivery: Delivery): DeliveryIdentity {
  return {
    id: delivery.id,
    targetLaneId: delivery.targetLaneId,
    sequence: delivery.sequence,
    kind: delivery.kind,
    failureCount: delivery.failureCount,
  };
}

function requireStatus<S extends DeliveryStatus>(
  delivery: Delivery,
  status: S,
  operation: DeliveryOperation,
): asserts delivery is Extract<Delivery, { status: S }> {
  if (delivery.status !== status) {
    throw new InvalidDeliveryOperationError(
      operation,
      `Cannot ${operation} from ${delivery.status} state`,
    );
  }
}

function assertUsableClaim(
  operation: "acknowledge_delivery" | "renew_claim",
  delivery: ClaimedDelivery,
  input: Readonly<{
    claimId: string;
    bindingGeneration: number;
    currentGeneration: number;
    now: number;
  }>,
): void {
  assertCurrentGeneration(
    operation,
    delivery.bindingGeneration,
    input.currentGeneration,
  );
  assertCurrentGeneration(
    operation,
    input.bindingGeneration,
    input.currentGeneration,
  );
  if (input.claimId !== delivery.claimId) {
    throw new ClaimMismatchError(operation, input.claimId, delivery.claimId);
  }
  if (input.now >= delivery.leaseDeadlineAt) {
    throw new ClaimExpiredError(
      operation,
      input.now,
      delivery.leaseDeadlineAt,
    );
  }
}

function assertCurrentGeneration(
  operation: DeliveryOperation,
  provided: number,
  current: number,
): void {
  if (provided !== current) {
    throw new StaleBindingGenerationError(operation, provided, current);
  }
}

function assertValidLeaseDeadline(
  operation: "claim_delivery" | "renew_claim",
  leaseDeadlineAt: number,
  now: number,
): void {
  if (!Number.isFinite(leaseDeadlineAt) || leaseDeadlineAt <= now) {
    throw new InvalidDeliveryOperationError(
      operation,
      "Claim lease deadline must be finite and later than now",
      { provided: leaseDeadlineAt, current: now },
    );
  }
}

function copyAckOutcome(outcome: AckOutcome): AckOutcome {
  switch (outcome.kind) {
    case "replied":
      return { kind: "replied", replyMessageId: outcome.replyMessageId };
    case "recorded":
      return {
        kind: "recorded",
        summary: outcome.summary,
        ...(outcome.documentPath === undefined ? {} : { documentPath: outcome.documentPath }),
        ...(outcome.externalTaskId === undefined ? {} : { externalTaskId: outcome.externalTaskId }),
      };
    case "rejected":
      return { kind: "rejected", reason: outcome.reason };
  }
}

function unresolvedInSequence(
  deliveries: readonly Delivery[],
  kind: Delivery["kind"],
): Delivery[] {
  return deliveries
    .filter(
      (delivery) =>
        delivery.kind === kind &&
        delivery.status !== "acknowledged" &&
        delivery.status !== "parked",
    )
    .sort((left, right) => left.sequence - right.sequence);
}

function claimableOrBlocked(
  delivery: Delivery | undefined,
  now: number,
): PendingDelivery | NotifiedDelivery | null {
  if (delivery?.status === "notified") {
    return delivery;
  }
  if (
    delivery?.status === "pending" &&
    (delivery.nextAttemptAt === null || now >= delivery.nextAttemptAt)
  ) {
    return delivery;
  }
  return null;
}
