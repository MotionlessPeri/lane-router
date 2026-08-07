import { describe, expect, it } from "vitest";

import {
  acknowledgeDelivery,
  applyAdapterResult,
  assertLegalDeliveryTransition,
  claimDelivery,
  deferDelivery,
  expireClaim,
  expireNotification,
  parkDelivery,
  recordStartedTurnEndedBeforeClaim,
  renewClaim,
  selectNextEligibleDelivery,
  unparkDelivery,
  type Delivery,
} from "../../src/core/delivery-state.js";
import {
  ClaimExpiredError,
  ClaimMismatchError,
  DeadlineNotExpiredError,
  IllegalDeliveryTransitionError,
  InvalidDeliveryOperationError,
  StaleBindingGenerationError,
} from "../../src/core/errors.js";
import {
  establishBindingConnection,
  type PendingDelivery,
} from "../../src/core/model.js";

const NOW = 1_000;
const FAILURE_LIMIT = 5;

function pending(
  sequence = 1,
  kind: Delivery["kind"] = "normal",
  nextAttemptAt: number | null = null,
): PendingDelivery {
  return {
    id: `delivery-${sequence}-${kind}`,
    targetLaneId: "lane-1",
    sequence,
    kind,
    failureCount: 0,
    status: "pending",
    nextAttemptAt,
  };
}

function claimed(leaseDeadlineAt = NOW + 100) {
  return claimDelivery(pending(), {
    claimId: "claim-1",
    bindingGeneration: 3,
    currentGeneration: 3,
    now: NOW,
    leaseDeadlineAt,
  });
}

function adapterContext() {
  return {
    claimDeadlineAt: NOW + 100,
    queueDeadlineAt: NOW + 500,
    failureLimit: FAILURE_LIMIT,
    nextAttemptAt: NOW + 50,
  } as const;
}

function captureError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected operation to throw");
}

describe("retry eligibility boundaries", () => {
  it.each([
    [NOW - 1, null],
    [NOW, 1],
    [NOW + 1, 1],
  ] as const)("at now=%s returns sequence %s", (now, expectedSequence) => {
    const selected = selectNextEligibleDelivery(
      [pending(1, "normal", NOW), pending(2)],
      "lane-1",
      now,
    );

    if (expectedSequence === null) {
      expect(selected).toBeNull();
    } else {
      expect(selected).toMatchObject({ sequence: expectedSequence });
    }
  });

  it("lets a ready correction overtake a normal waiting for retry", () => {
    expect(
      selectNextEligibleDelivery(
        [pending(1, "normal", NOW + 100), pending(2, "correction")],
        "lane-1",
        NOW,
      ),
    ).toMatchObject({ sequence: 2, kind: "correction" });
  });

  it("keeps correction priority while the earliest correction waits for retry", () => {
    expect(
      selectNextEligibleDelivery(
        [
          pending(1, "normal"),
          pending(2, "correction", NOW + 100),
          pending(3, "correction"),
        ],
        "lane-1",
        NOW,
      ),
    ).toBeNull();
  });
});

describe("claim lease validity", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, NOW - 1, NOW])(
    "rejects invalid initial lease deadline %s",
    (leaseDeadlineAt) => {
      expect(() =>
        claimDelivery(pending(), {
          claimId: "claim-invalid",
          bindingGeneration: 3,
          currentGeneration: 3,
          now: NOW,
          leaseDeadlineAt,
        }),
      ).toThrow(InvalidDeliveryOperationError);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, NOW - 1, NOW])(
    "rejects invalid renewal deadline %s",
    (leaseDeadlineAt) => {
      expect(() =>
        renewClaim(claimed(), {
          claimId: "claim-1",
          bindingGeneration: 3,
          currentGeneration: 3,
          now: NOW,
          leaseDeadlineAt,
        }),
      ).toThrow(InvalidDeliveryOperationError);
    },
  );

  it("rejects shortening an existing valid lease", () => {
    expect(() =>
      renewClaim(claimed(NOW + 100), {
        claimId: "claim-1",
        bindingGeneration: 3,
        currentGeneration: 3,
        now: NOW + 10,
        leaseDeadlineAt: NOW + 99,
      }),
    ).toThrow(InvalidDeliveryOperationError);
  });

  it("allows renewing to the same deadline", () => {
    expect(
      renewClaim(claimed(NOW + 100), {
        claimId: "claim-1",
        bindingGeneration: 3,
        currentGeneration: 3,
        now: NOW + 10,
        leaseDeadlineAt: NOW + 100,
      }).leaseDeadlineAt,
    ).toBe(NOW + 100);
  });
});

describe("acknowledgement outcome immutability", () => {
  it("copies each outcome payload instead of retaining caller-owned objects", () => {
    const replied = { kind: "replied" as const, replyMessageId: "reply-1" };
    const recorded = {
      kind: "recorded" as const,
      summary: "initial summary",
      documentPath: "docs/result.md",
    };
    const rejected = { kind: "rejected" as const, reason: "initial reason" };

    const acknowledged = [replied, recorded, rejected].map((outcome) =>
      acknowledgeDelivery(claimed(), {
        claimId: "claim-1",
        bindingGeneration: 3,
        currentGeneration: 3,
        now: NOW + 1,
        outcome,
      }),
    );

    replied.replyMessageId = "mutated-reply";
    recorded.summary = "mutated summary";
    recorded.documentPath = "mutated-reference";
    rejected.reason = "mutated reason";

    expect(acknowledged.map((delivery) => delivery.outcome)).toEqual([
      { kind: "replied", replyMessageId: "reply-1" },
      {
        kind: "recorded",
        summary: "initial summary",
        documentPath: "docs/result.md",
      },
      { kind: "rejected", reason: "initial reason" },
    ]);
  });
});

describe("public operation errors", () => {
  const queued = applyAdapterResult(pending(), "queued_next_turn", adapterContext());
  const activeClaim = claimed();
  const acknowledged = acknowledgeDelivery(activeClaim, {
    claimId: "claim-1",
    bindingGeneration: 3,
    currentGeneration: 3,
    now: NOW + 1,
    outcome: { kind: "recorded", summary: "handled" },
  });
  const parked = parkDelivery(pending(), "operator review");

  it.each([
    ["apply_adapter_result", () => applyAdapterResult(activeClaim, "stored_pending", adapterContext())],
    ["defer_delivery", () => deferDelivery(activeClaim, "offline")],
    ["expire_notification", () => expireNotification(pending(), { now: NOW, failureLimit: FAILURE_LIMIT, nextAttemptAt: NOW + 1 })],
    ["record_started_turn_ended_before_claim", () => recordStartedTurnEndedBeforeClaim(queued, { failureLimit: FAILURE_LIMIT, nextAttemptAt: NOW + 1 })],
    ["claim_delivery", () => claimDelivery(activeClaim, { claimId: "claim-2", bindingGeneration: 3, currentGeneration: 3, now: NOW, leaseDeadlineAt: NOW + 100 })],
    ["renew_claim", () => renewClaim(pending(), { claimId: "claim-1", bindingGeneration: 3, currentGeneration: 3, now: NOW, leaseDeadlineAt: NOW + 100 })],
    ["acknowledge_delivery", () => acknowledgeDelivery(pending(), { claimId: "claim-1", bindingGeneration: 3, currentGeneration: 3, now: NOW, outcome: { kind: "recorded", summary: "handled" } })],
    ["expire_claim", () => expireClaim(pending(), { now: NOW, failureLimit: FAILURE_LIMIT, nextAttemptAt: NOW + 1 })],
    ["park_delivery", () => parkDelivery(parked, "again")],
    ["park_delivery", () => parkDelivery(acknowledged, "too late")],
    ["unpark_delivery", () => unparkDelivery(pending())],
    ["establish_binding_connection", () => establishBindingConnection({ id: "binding-1", generation: 3, adapter: "codex", conversationId: "thread-1", status: "unbound" }, { bindingGeneration: 3, connectedAt: NOW })],
  ] as const)("reports structured operation context for %s", (operation, action) => {
    const error = captureError(action);

    expect(error).toBeInstanceOf(InvalidDeliveryOperationError);
    expect(error).toMatchObject({ operation });
  });

  it.each([
    ["renew_claim", () => renewClaim(activeClaim, { claimId: "wrong", bindingGeneration: 3, currentGeneration: 3, now: NOW + 1, leaseDeadlineAt: NOW + 200 })],
    ["acknowledge_delivery", () => acknowledgeDelivery(activeClaim, { claimId: "wrong", bindingGeneration: 3, currentGeneration: 3, now: NOW + 1, outcome: { kind: "recorded", summary: "handled" } })],
  ] as const)("reports mismatched claim context for %s", (operation, action) => {
    const error = captureError(action);

    expect(error).toBeInstanceOf(ClaimMismatchError);
    expect(error).toMatchObject({ operation, provided: "wrong", current: "claim-1" });
  });

  it.each([
    ["renew_claim", () => renewClaim(activeClaim, { claimId: "claim-1", bindingGeneration: 3, currentGeneration: 3, now: NOW + 100, leaseDeadlineAt: NOW + 200 })],
    ["acknowledge_delivery", () => acknowledgeDelivery(activeClaim, { claimId: "claim-1", bindingGeneration: 3, currentGeneration: 3, now: NOW + 100, outcome: { kind: "recorded", summary: "handled" } })],
  ] as const)("reports expired claim context for %s", (operation, action) => {
    const error = captureError(action);

    expect(error).toBeInstanceOf(ClaimExpiredError);
    expect(error).toMatchObject({ operation, provided: NOW + 100, current: NOW + 100 });
  });

  it("reports premature notification expiry context", () => {
    const notified = applyAdapterResult(pending(), "started_new_turn", adapterContext());
    const error = captureError(() =>
      expireNotification(notified, {
        now: NOW + 99,
        failureLimit: FAILURE_LIMIT,
        nextAttemptAt: NOW + 200,
      }),
    );

    expect(error).toBeInstanceOf(DeadlineNotExpiredError);
    expect(error).toMatchObject({
      operation: "expire_notification",
      provided: NOW + 99,
      current: NOW + 100,
    });
  });

  it("reports premature claim expiry context", () => {
    const error = captureError(() =>
      expireClaim(activeClaim, {
        now: NOW + 99,
        failureLimit: FAILURE_LIMIT,
        nextAttemptAt: NOW + 200,
      }),
    );

    expect(error).toBeInstanceOf(DeadlineNotExpiredError);
    expect(error).toMatchObject({
      operation: "expire_claim",
      provided: NOW + 99,
      current: NOW + 100,
    });
  });

  it("reports illegal transition context including self transitions", () => {
    const error = captureError(() =>
      assertLegalDeliveryTransition("pending", "pending"),
    );

    expect(error).toBeInstanceOf(IllegalDeliveryTransitionError);
    expect(error).toMatchObject({ from: "pending", to: "pending" });
  });

  it("reports stale generation context", () => {
    const error = captureError(() =>
      claimDelivery(pending(), {
        claimId: "claim-stale",
        bindingGeneration: 2,
        currentGeneration: 3,
        now: NOW,
        leaseDeadlineAt: NOW + 100,
      }),
    );

    expect(error).toBeInstanceOf(StaleBindingGenerationError);
    expect(error).toMatchObject({ provided: 2, current: 3 });
  });
});
