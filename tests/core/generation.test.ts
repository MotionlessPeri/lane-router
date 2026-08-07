import { describe, expect, it } from "vitest";

import {
  acknowledgeDelivery,
  claimDelivery,
  renewClaim,
  type Delivery,
} from "../../src/core/delivery-state.js";
import { establishBindingConnection } from "../../src/core/model.js";
import { StaleBindingGenerationError } from "../../src/core/errors.js";

const NOW = 1_000;

function pending(): Delivery {
  return {
    id: "delivery-1",
    targetLaneId: "lane-1",
    sequence: 1,
    kind: "normal",
    failureCount: 0,
    status: "pending",
    nextAttemptAt: null,
  };
}

function claimInGeneration(generation: number) {
  return claimDelivery(pending(), {
    claimId: "claim-1",
    bindingGeneration: generation,
    currentGeneration: generation,
    now: NOW,
    leaseDeadlineAt: NOW + 100,
  });
}

describe("binding generation fence", () => {
  it("rejects claim from a stale binding generation", () => {
    expect(() =>
      claimDelivery(pending(), {
        claimId: "claim-stale",
        bindingGeneration: 2,
        currentGeneration: 3,
        now: NOW,
        leaseDeadlineAt: NOW + 100,
      }),
    ).toThrow(StaleBindingGenerationError);
  });

  it("rejects renewal of a claim carried by a stale generation", () => {
    const claimed = claimInGeneration(2);

    expect(() =>
      renewClaim(claimed, {
        claimId: "claim-1",
        bindingGeneration: 2,
        currentGeneration: 3,
        now: NOW + 10,
        leaseDeadlineAt: NOW + 200,
      }),
    ).toThrow(StaleBindingGenerationError);
  });

  it("rejects acknowledgement from a stale generation", () => {
    const claimed = claimInGeneration(2);

    expect(() =>
      acknowledgeDelivery(claimed, {
        claimId: "claim-1",
        bindingGeneration: 2,
        currentGeneration: 3,
        now: NOW + 10,
        outcome: { kind: "recorded", summary: "handled" },
      }),
    ).toThrow(StaleBindingGenerationError);
  });

  it("rejects a stale generation establishing the current connection", () => {
    expect(() =>
      establishBindingConnection(
        {
          id: "binding-1",
          generation: 3,
          adapter: "codex",
          conversationId: "thread-1",
          status: "bound",
        },
        { bindingGeneration: 2, connectedAt: NOW },
      ),
    ).toThrow(StaleBindingGenerationError);
  });

  it("allows current-generation claim, renewal, acknowledgement, and connection", () => {
    const claimed = claimInGeneration(3);
    const renewed = renewClaim(claimed, {
      claimId: "claim-1",
      bindingGeneration: 3,
      currentGeneration: 3,
      now: NOW + 10,
      leaseDeadlineAt: NOW + 300,
    });
    const acknowledged = acknowledgeDelivery(renewed, {
      claimId: "claim-1",
      bindingGeneration: 3,
      currentGeneration: 3,
      now: NOW + 20,
      outcome: { kind: "recorded", summary: "handled" },
    });
    const connection = establishBindingConnection(
      {
        id: "binding-1",
        generation: 3,
        adapter: "codex",
        conversationId: "thread-1",
        status: "bound",
      },
      { bindingGeneration: 3, connectedAt: NOW },
    );

    expect(renewed.leaseDeadlineAt).toBe(NOW + 300);
    expect(acknowledged).toMatchObject({
      status: "acknowledged",
      bindingGeneration: 3,
      claimId: "claim-1",
    });
    expect(connection).toEqual({
      bindingId: "binding-1",
      generation: 3,
      connectedAt: NOW,
    });
  });
});
