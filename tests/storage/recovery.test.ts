import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/storage/database.js";
import { recoverDatabase } from "../../src/storage/recovery.js";
import { StorageRepositories } from "../../src/storage/repositories.js";
import { seedStorage, STORAGE_IDS } from "../fixtures/storage/seed.js";

const NOW = 1_000;
const FAILURE_LIMIT = 3;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "lane-router-recovery-"));
  temporaryDirectories.push(directory);
  return join(directory, "router.sqlite");
}

function addDelivery(
  repositories: StorageRepositories,
  id: string,
  createdAt: number,
): void {
  repositories.createMessageWithInitialDelivery({
    messageId: `message-${id}`,
    deliveryId: id,
    senderBindingId: STORAGE_IDS.bindingId,
    targetLaneId: STORAGE_IDS.laneId,
    kind: "normal",
    body: `body-${id}`,
    metadata: {},
    replyTo: null,
    createdAt,
  });
}

describe("restart recovery", () => {
  it("deterministically recovers expired states and preserves future or terminal states", () => {
    const path = createDatabasePath();
    const setup = openDatabase(path);
    seedStorage(setup);
    const repositories = new StorageRepositories(setup);
    const ids = [
      "pending", "claim-future", "claim-expired", "claim-parks",
      "queue-future", "queue-expired", "lease-future", "lease-expired",
      "lease-parks", "acknowledged", "parked",
    ];
    ids.forEach((id, index) => addDelivery(repositories, id, index + 10));
    setup.transaction(() => {
      setup.prepare("UPDATE delivery SET next_attempt_at = ? WHERE id = 'pending'").run(NOW + 50);
      setup.prepare("UPDATE delivery SET state='notified', deadline_kind='claim', deadline_at=?, adapter_result='started_new_turn', failure_count=1 WHERE id='claim-future'").run(NOW + 1);
      setup.prepare("UPDATE delivery SET state='notified', deadline_kind='claim', deadline_at=?, adapter_result='started_new_turn', failure_count=1 WHERE id='claim-expired'").run(NOW);
      setup.prepare("UPDATE delivery SET state='notified', deadline_kind='claim', deadline_at=?, adapter_result='applied_current_turn', failure_count=2 WHERE id='claim-parks'").run(NOW - 1);
      setup.prepare("UPDATE delivery SET state='notified', deadline_kind='queue', deadline_at=?, adapter_result='queued_next_turn', failure_count=1 WHERE id='queue-future'").run(NOW + 1);
      setup.prepare("UPDATE delivery SET state='notified', deadline_kind='queue', deadline_at=?, adapter_result='queued_next_turn', failure_count=1 WHERE id='queue-expired'").run(NOW);
      setup.prepare("UPDATE delivery SET state='parked', park_reason='operator review' WHERE id='parked'").run();
    })();
    repositories.createClaim({ claimId: "future-claim", deliveryId: "lease-future", generation: 1, createdAt: 100, leaseDeadlineAt: NOW + 1 });
    repositories.createClaim({ claimId: "expired-claim", deliveryId: "lease-expired", generation: 1, createdAt: 100, leaseDeadlineAt: NOW });
    repositories.createClaim({ claimId: "parking-claim", deliveryId: "lease-parks", generation: 1, createdAt: 100, leaseDeadlineAt: NOW - 1 });
    setup.prepare("UPDATE delivery SET failure_count=2 WHERE id='lease-parks'").run();
    repositories.createClaim({ claimId: "ack-claim", deliveryId: "acknowledged", generation: 1, createdAt: 100, leaseDeadlineAt: NOW + 50 });
    repositories.acknowledge({
      deliveryId: "acknowledged", claimId: "ack-claim", generation: 1,
      outcome: { kind: "recorded", summary: "done" }, acknowledgedAt: 200,
    });
    setup.close();

    const reopened = openDatabase(path);
    try {
      const result = recoverDatabase(reopened, {
        now: NOW,
        failureLimit: FAILURE_LIMIT,
        retryDelay: (failureCount) => failureCount * 10,
      });
      expect(result).toEqual({ recovered: 5, parked: 2 });

      const rows = Object.fromEntries((reopened.prepare(`
        SELECT id, state, failure_count, deadline_kind, deadline_at, next_attempt_at, park_reason
        FROM delivery
      `).all() as Array<Record<string, unknown>>).map((row) => [row.id, row]));
      expect(rows.pending).toMatchObject({ state: "pending", failure_count: 0, next_attempt_at: NOW + 50 });
      expect(rows["claim-future"]).toMatchObject({ state: "notified", failure_count: 1, deadline_at: NOW + 1 });
      expect(rows["claim-expired"]).toMatchObject({ state: "pending", failure_count: 2, next_attempt_at: NOW + 20 });
      expect(rows["claim-parks"]).toMatchObject({ state: "parked", failure_count: 3, park_reason: "failure_limit" });
      expect(rows["queue-future"]).toMatchObject({ state: "notified", failure_count: 1, deadline_at: NOW + 1 });
      expect(rows["queue-expired"]).toMatchObject({ state: "pending", failure_count: 1, next_attempt_at: null });
      expect(rows["lease-future"]).toMatchObject({ state: "claimed", failure_count: 0, deadline_at: NOW + 1 });
      expect(rows["lease-expired"]).toMatchObject({ state: "pending", failure_count: 1, next_attempt_at: NOW + 10 });
      expect(rows["lease-parks"]).toMatchObject({ state: "parked", failure_count: 3, park_reason: "failure_limit" });
      expect(rows.acknowledged).toMatchObject({ state: "acknowledged" });
      expect(rows.parked).toMatchObject({ state: "parked", park_reason: "operator review" });

      expect(reopened.prepare("SELECT closed_at, close_reason FROM claim WHERE id='expired-claim'").get()).toEqual({
        closed_at: NOW, close_reason: "lease_expired",
      });
      const recoveryEvents = (reopened.prepare("SELECT COUNT(*) count FROM event WHERE event_type LIKE 'recovery_%'").get() as { count: number }).count;
      expect(recoveryEvents).toBe(5);
      expect(recoverDatabase(reopened, {
        now: NOW,
        failureLimit: FAILURE_LIMIT,
        retryDelay: (failureCount) => failureCount * 10,
      })).toEqual({ recovered: 0, parked: 0 });
      expect((reopened.prepare("SELECT COUNT(*) count FROM event WHERE event_type LIKE 'recovery_%'").get() as { count: number }).count).toBe(recoveryEvents);
    } finally {
      reopened.close();
    }
  });
});
