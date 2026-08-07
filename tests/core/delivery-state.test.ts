import { describe, expect, it } from "vitest";

import {
  applyAdapterResult,
  assertLegalDeliveryTransition,
  claimDelivery,
  deferDelivery,
  expireClaim,
  expireNotification,
  parkDelivery,
  recordStartedTurnEndedBeforeClaim,
  selectNextEligibleDelivery,
  unparkDelivery,
  type Delivery,
  type DeliveryStatus,
} from "../../src/core/delivery-state.js";
import { IllegalDeliveryTransitionError } from "../../src/core/errors.js";

const NOW = 1_000;
const FAILURE_LIMIT = 5;

function pending(
  sequence = 1,
  kind: Delivery["kind"] = "normal",
  failureCount = 0,
): Delivery {
  return {
    id: `delivery-${sequence}-${kind}`,
    targetLaneId: "lane-1",
    sequence,
    kind,
    failureCount,
    status: "pending",
    nextAttemptAt: null,
  };
}

describe("delivery transition graph", () => {
  const legal: ReadonlyArray<readonly [DeliveryStatus, DeliveryStatus]> = [
    ["pending", "notified"],
    ["pending", "claimed"],
    ["pending", "parked"],
    ["notified", "pending"],
    ["notified", "claimed"],
    ["notified", "parked"],
    ["claimed", "pending"],
    ["claimed", "acknowledged"],
    ["claimed", "parked"],
    ["parked", "pending"],
  ];

  it.each(legal)("accepts %s -> %s", (from, to) => {
    expect(() => assertLegalDeliveryTransition(from, to)).not.toThrow();
  });

  const statuses: readonly DeliveryStatus[] = [
    "pending",
    "notified",
    "claimed",
    "acknowledged",
    "parked",
  ];
  const legalKeys = new Set(legal.map(([from, to]) => `${from}:${to}`));
  const illegal = statuses.flatMap((from) =>
    statuses
      .filter((to) => from !== to && !legalKeys.has(`${from}:${to}`))
      .map((to) => [from, to] as const),
  );

  it.each(illegal)("rejects %s -> %s", (from, to) => {
    expect(() => assertLegalDeliveryTransition(from, to)).toThrow(
      IllegalDeliveryTransitionError,
    );
  });
});

describe("adapter outcomes and notified deadlines", () => {
  it.each(["started_new_turn", "applied_current_turn"] as const)(
    "%s starts a claim deadline",
    (result) => {
      const delivery = applyAdapterResult(pending(), result, {
        claimDeadlineAt: NOW + 100,
        queueDeadlineAt: NOW + 500,
        failureLimit: FAILURE_LIMIT,
        nextAttemptAt: NOW + 50,
      });

      expect(delivery).toMatchObject({
        status: "notified",
        notificationKind: "claim",
        deadlineAt: NOW + 100,
        adapterResult: result,
        failureCount: 0,
      });
    },
  );

  it("queued_next_turn starts a queue deadline", () => {
    const delivery = applyAdapterResult(pending(), "queued_next_turn", {
      claimDeadlineAt: NOW + 100,
      queueDeadlineAt: NOW + 500,
      failureLimit: FAILURE_LIMIT,
      nextAttemptAt: NOW + 50,
    });

    expect(delivery).toMatchObject({
      status: "notified",
      notificationKind: "queue",
      deadlineAt: NOW + 500,
      adapterResult: "queued_next_turn",
      failureCount: 0,
    });
  });

  it.each(["stored_pending", "binding_not_found"] as const)(
    "%s remains pending without adding a failure",
    (result) => {
      expect(
        applyAdapterResult(pending(1, "normal", 2), result, {
          claimDeadlineAt: NOW + 100,
          queueDeadlineAt: NOW + 500,
          failureLimit: FAILURE_LIMIT,
          nextAttemptAt: NOW + 50,
        }),
      ).toMatchObject({ status: "pending", failureCount: 2 });
    },
  );

  it.each(["offline", "unbound"] as const)(
    "%s waiting remains pending without adding a failure",
    (reason) => {
      expect(deferDelivery(pending(1, "normal", 2), reason)).toMatchObject({
        status: "pending",
        failureCount: 2,
        nextAttemptAt: null,
      });
    },
  );

  it("adapter_failed increments the failure count and schedules retry", () => {
    expect(
      applyAdapterResult(pending(1, "normal", 2), "adapter_failed", {
        claimDeadlineAt: NOW + 100,
        queueDeadlineAt: NOW + 500,
        failureLimit: FAILURE_LIMIT,
        nextAttemptAt: NOW + 50,
      }),
    ).toMatchObject({
      status: "pending",
      failureCount: 3,
      nextAttemptAt: NOW + 50,
    });
  });

  it("claim deadline expiry adds a failure", () => {
    const notified = applyAdapterResult(pending(1, "normal", 1), "started_new_turn", {
      claimDeadlineAt: NOW,
      queueDeadlineAt: NOW + 500,
      failureLimit: FAILURE_LIMIT,
      nextAttemptAt: NOW + 50,
    });

    expect(
      expireNotification(notified, {
        now: NOW,
        failureLimit: FAILURE_LIMIT,
        nextAttemptAt: NOW + 50,
      }),
    ).toMatchObject({
      status: "pending",
      failureCount: 2,
      nextAttemptAt: NOW + 50,
    });
  });

  it("queue deadline expiry returns pending without adding a failure", () => {
    const notified = applyAdapterResult(pending(1, "normal", 2), "queued_next_turn", {
      claimDeadlineAt: NOW + 100,
      queueDeadlineAt: NOW,
      failureLimit: FAILURE_LIMIT,
      nextAttemptAt: NOW + 50,
    });

    expect(
      expireNotification(notified, {
        now: NOW,
        failureLimit: FAILURE_LIMIT,
        nextAttemptAt: NOW + 50,
      }),
    ).toMatchObject({
      status: "pending",
      failureCount: 2,
      nextAttemptAt: null,
    });
  });

  it("a started turn ending before claim adds a failure", () => {
    const notified = applyAdapterResult(pending(), "applied_current_turn", {
      claimDeadlineAt: NOW + 100,
      queueDeadlineAt: NOW + 500,
      failureLimit: FAILURE_LIMIT,
      nextAttemptAt: NOW + 50,
    });

    expect(
      recordStartedTurnEndedBeforeClaim(notified, {
        failureLimit: FAILURE_LIMIT,
        nextAttemptAt: NOW + 50,
      }),
    ).toMatchObject({ status: "pending", failureCount: 1 });
  });
});

describe("claims and automatic parking", () => {
  it("claim lease expiry closes the claim and adds a failure", () => {
    const claimed = claimDelivery(pending(1, "normal", 1), {
      claimId: "claim-1",
      bindingGeneration: 3,
      currentGeneration: 3,
      now: NOW,
      leaseDeadlineAt: NOW + 100,
    });

    expect(
      expireClaim(claimed, {
        now: NOW + 100,
        failureLimit: FAILURE_LIMIT,
        nextAttemptAt: NOW + 200,
      }),
    ).toMatchObject({
      status: "pending",
      failureCount: 2,
      nextAttemptAt: NOW + 200,
    });
  });

  it.each([
    ["adapter failure", (delivery: Delivery) =>
      applyAdapterResult(delivery, "adapter_failed", {
        claimDeadlineAt: NOW + 100,
        queueDeadlineAt: NOW + 500,
        failureLimit: FAILURE_LIMIT,
        nextAttemptAt: NOW + 50,
      })],
    ["claim deadline", (delivery: Delivery) =>
      expireNotification(
        applyAdapterResult(delivery, "started_new_turn", {
          claimDeadlineAt: NOW,
          queueDeadlineAt: NOW + 500,
          failureLimit: FAILURE_LIMIT,
          nextAttemptAt: NOW + 50,
        }),
        { now: NOW, failureLimit: FAILURE_LIMIT, nextAttemptAt: NOW + 50 },
      )],
    ["started turn ending", (delivery: Delivery) =>
      recordStartedTurnEndedBeforeClaim(
        applyAdapterResult(delivery, "started_new_turn", {
          claimDeadlineAt: NOW + 100,
          queueDeadlineAt: NOW + 500,
          failureLimit: FAILURE_LIMIT,
          nextAttemptAt: NOW + 50,
        }),
        { failureLimit: FAILURE_LIMIT, nextAttemptAt: NOW + 50 },
      )],
    ["claim lease", (delivery: Delivery) =>
      expireClaim(
        claimDelivery(delivery, {
          claimId: "claim-1",
          bindingGeneration: 3,
          currentGeneration: 3,
          now: NOW,
          leaseDeadlineAt: NOW + 1,
        }),
        { now: NOW + 1, failureLimit: FAILURE_LIMIT, nextAttemptAt: NOW + 50 },
      )],
  ] as const)("%s parks when it reaches the failure limit", (_name, fail) => {
    expect(fail(pending(1, "normal", FAILURE_LIMIT - 1))).toMatchObject({
      status: "parked",
      failureCount: FAILURE_LIMIT,
      reason: "failure_limit",
    });
  });

  it("manual park and unpark preserve sequence and failure history", () => {
    const original = pending(7, "normal", 3);
    const parked = parkDelivery(original, "operator review");

    expect(unparkDelivery(parked)).toEqual(original);
  });
});

describe("FIFO eligibility and correction priority", () => {
  it("selects only the earliest unresolved normal delivery", () => {
    expect(
      selectNextEligibleDelivery(
        [pending(2), pending(1), pending(3)],
        "lane-1",
        NOW,
      ),
    ).toMatchObject({ sequence: 1, kind: "normal" });
  });

  it("does not let a later normal overtake an earlier claimed normal", () => {
    const first = claimDelivery(pending(1), {
      claimId: "claim-1",
      bindingGeneration: 1,
      currentGeneration: 1,
      now: NOW,
      leaseDeadlineAt: NOW + 100,
    });

    expect(
      selectNextEligibleDelivery([pending(2), first], "lane-1", NOW),
    ).toBeNull();
  });

  it("lets corrections overtake normals but preserves correction sequence", () => {
    expect(
      selectNextEligibleDelivery([
        pending(1, "normal"),
        pending(4, "correction"),
        pending(3, "correction"),
        pending(2, "normal"),
      ], "lane-1", NOW),
    ).toMatchObject({ sequence: 3, kind: "correction" });
  });

  it("resumes normal FIFO after corrections are acknowledged or parked", () => {
    const acknowledgedCorrection: Delivery = {
      ...pending(3, "correction"),
      status: "acknowledged",
      claimId: "claim-correction",
      bindingGeneration: 1,
      outcome: { kind: "recorded", summary: "handled" },
      acknowledgedAt: NOW,
    };
    const parkedCorrection = parkDelivery(pending(4, "correction"), "operator review");

    expect(
      selectNextEligibleDelivery([
        pending(2, "normal"),
        acknowledgedCorrection,
        parkedCorrection,
        pending(1, "normal"),
      ], "lane-1", NOW),
    ).toMatchObject({ sequence: 1, kind: "normal" });
  });

  it("parked poison messages stop blocking later normals", () => {
    expect(
      selectNextEligibleDelivery([
        parkDelivery(pending(1), "failure_limit"),
        pending(2),
      ], "lane-1", NOW),
    ).toMatchObject({ sequence: 2 });
  });

  it("evaluates FIFO independently for each target lane", () => {
    const otherLaneCorrection: Delivery = {
      ...pending(1, "correction"),
      id: "delivery-other-lane",
      targetLaneId: "lane-2",
    };

    expect(
      selectNextEligibleDelivery(
        [otherLaneCorrection, pending(2, "normal")],
        "lane-1",
        NOW,
      ),
    ).toMatchObject({ targetLaneId: "lane-1", sequence: 2 });
  });
});
