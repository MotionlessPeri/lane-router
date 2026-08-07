import type { AdapterResult } from "./adapter-contract.js";
import {
  ClaimExpiredError,
  ClaimMismatchError,
  DeadlineNotExpiredError,
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
  requireStatus(delivery, "pending", "apply an adapter result");

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
  requireStatus(delivery, "pending", "defer a delivery");
  return toPending(delivery, delivery.failureCount, null);
}

export function expireNotification(
  delivery: Delivery,
  context: ExpirationContext,
): PendingDelivery | ParkedDelivery {
  requireStatus(delivery, "notified", "expire a notification");
  if (context.now < delivery.deadlineAt) {
    throw new DeadlineNotExpiredError("Notification deadline has not expired");
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
  requireStatus(delivery, "notified", "record a turn ending before claim");
  if (delivery.notificationKind !== "claim") {
    throw new InvalidDeliveryOperationError(
      "A queued notification does not represent a started turn",
    );
  }
  return recordFailure(delivery, context);
}

export function claimDelivery(delivery: Delivery, input: ClaimInput): ClaimedDelivery {
  if (delivery.status !== "pending" && delivery.status !== "notified") {
    throw new InvalidDeliveryOperationError(
      `Cannot claim a delivery in ${delivery.status} state`,
    );
  }
  if (delivery.status === "notified" && input.now >= delivery.deadlineAt) {
    throw new InvalidDeliveryOperationError("Cannot claim after notification expiry");
  }
  assertCurrentGeneration(input.bindingGeneration, input.currentGeneration);
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
  requireStatus(delivery, "claimed", "renew a claim");
  assertUsableClaim(delivery, input);
  return {
    ...delivery,
    leaseDeadlineAt: input.leaseDeadlineAt,
  };
}

export function acknowledgeDelivery(
  delivery: Delivery,
  input: AcknowledgeInput,
): AcknowledgedDelivery {
  requireStatus(delivery, "claimed", "acknowledge a delivery");
  assertUsableClaim(delivery, input);
  assertLegalDeliveryTransition("claimed", "acknowledged");
  return {
    ...identityOf(delivery),
    status: "acknowledged",
    claimId: delivery.claimId,
    bindingGeneration: delivery.bindingGeneration,
    outcome: input.outcome,
    acknowledgedAt: input.now,
  };
}

export function expireClaim(
  delivery: Delivery,
  context: ExpirationContext,
): PendingDelivery | ParkedDelivery {
  requireStatus(delivery, "claimed", "expire a claim");
  if (context.now < delivery.leaseDeadlineAt) {
    throw new DeadlineNotExpiredError("Claim lease has not expired");
  }
  return recordFailure(delivery, context);
}

export function parkDelivery(delivery: Delivery, reason: string): ParkedDelivery {
  if (delivery.status === "acknowledged" || delivery.status === "parked") {
    throw new InvalidDeliveryOperationError(
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
  requireStatus(delivery, "parked", "unpark a delivery");
  assertLegalDeliveryTransition("parked", "pending");
  return toPending(delivery, delivery.failureCount, null);
}

export function selectNextEligibleDelivery(
  deliveries: readonly Delivery[],
  targetLaneId: string,
): PendingDelivery | NotifiedDelivery | null {
  const laneDeliveries = deliveries.filter(
    (delivery) => delivery.targetLaneId === targetLaneId,
  );
  const unresolvedCorrections = unresolvedInSequence(
    laneDeliveries,
    "correction",
  );
  if (unresolvedCorrections.length > 0) {
    return claimableOrBlocked(unresolvedCorrections[0]);
  }

  const unresolvedNormals = unresolvedInSequence(laneDeliveries, "normal");
  return unresolvedNormals.length === 0
    ? null
    : claimableOrBlocked(unresolvedNormals[0]);
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
  operation: string,
): asserts delivery is Extract<Delivery, { status: S }> {
  if (delivery.status !== status) {
    throw new InvalidDeliveryOperationError(
      `Cannot ${operation} from ${delivery.status} state`,
    );
  }
}

function assertUsableClaim(
  delivery: ClaimedDelivery,
  input: Readonly<{
    claimId: string;
    bindingGeneration: number;
    currentGeneration: number;
    now: number;
  }>,
): void {
  assertCurrentGeneration(delivery.bindingGeneration, input.currentGeneration);
  assertCurrentGeneration(input.bindingGeneration, input.currentGeneration);
  if (input.claimId !== delivery.claimId) {
    throw new ClaimMismatchError(`Claim ${input.claimId} is not current`);
  }
  if (input.now >= delivery.leaseDeadlineAt) {
    throw new ClaimExpiredError(`Claim ${delivery.claimId} has expired`);
  }
}

function assertCurrentGeneration(provided: number, current: number): void {
  if (provided !== current) {
    throw new StaleBindingGenerationError(provided, current);
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
): PendingDelivery | NotifiedDelivery | null {
  return delivery?.status === "pending" || delivery?.status === "notified"
    ? delivery
    : null;
}
