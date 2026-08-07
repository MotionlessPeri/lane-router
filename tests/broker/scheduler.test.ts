import { afterEach, expect, test } from "vitest";
import { BrokerService } from "../../src/broker/broker-service.js";
import { Scheduler } from "../../src/broker/scheduler.js";
import {
  openDatabase,
  type RouterDatabase,
} from "../../src/storage/database.js";
import type {
  AdapterDeliveryRequest,
  AdapterResult,
  DeliveryAdapter,
} from "../../src/core/adapter-contract.js";

const databases: RouterDatabase[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
class FakeAdapter implements DeliveryAdapter {
  requests: AdapterDeliveryRequest[] = [];
  constructor(
    private readonly result: AdapterResult,
    private turn: "idle" | "busy",
  ) {}
  async deliver(request: AdapterDeliveryRequest): Promise<AdapterResult> {
    this.requests.push(request);
    if (
      this.result === "started_new_turn" ||
      this.result === "applied_current_turn"
    )
      this.turn = "busy";
    return this.result;
  }
  async getRuntimeState() {
    return { availability: "online" as const, turn: this.turn };
  }
  setTurn(turn: "idle" | "busy"): void {
    this.turn = turn;
  }
}

test("DeliveryAdapter requires an explicit runtime-state capability", () => {
  if (false) {
    // @ts-expect-error scheduler adapters cannot omit runtime-state probing
    const incomplete: DeliveryAdapter = {
      deliver: async () => "stored_pending",
    };
    void incomplete;
  }
  expect(true).toBe(true);
});
function setup(result: AdapterResult) {
  const db = openDatabase(":memory:");
  databases.push(db);
  let now = 100;
  const service = new BrokerService(db, { now: () => now, randomId: (p) => p });
  const manifest = {
    projectId: "p",
    projectKey: "p",
    displayName: "P",
    manifestHash: "h",
    manifestVersion: 1,
    lanes: [
      { name: "a", roleFile: "a", communicationEntry: true },
      { name: "b", roleFile: "b", communicationEntry: false },
    ],
  };
  service.syncProject({
    operationId: "s",
    adminId: "x",
    workspaceId: "w",
    rootPath: "C:/r",
    manifest,
  });
  service.bind({
    operationId: "a",
    adminId: "x",
    bindingId: "ba",
    laneAddress: "p/a",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "a",
  });
  service.bind({
    operationId: "b",
    adminId: "x",
    bindingId: "bb",
    laneAddress: "p/b",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "b",
  });
  const adapter = new FakeAdapter(result, "idle");
  const scheduler = new Scheduler(
    db,
    { codex: adapter, claude: adapter },
    service.config,
    { now: () => now, random: () => 0.5 },
  );
  return {
    db,
    service,
    scheduler,
    adapter,
    setNow: (value: number) => {
      now = value;
    },
  };
}

test("binding-change retry leaves work pending without suppression or failure", async () => {
  const x = setup("binding_changed_retry");
  const sent = x.service.send({ operationId: "binding-retry", actor: { bindingId: "ba", generation: 1 }, target: "p/b", kind: "normal", body: "retry", metadata: {} });
  await x.scheduler.runOnce();
  expect(x.db.prepare("SELECT state,failure_count FROM delivery WHERE id=?").get(sent.deliveryId)).toEqual({ state: "pending", failure_count: 0 });
  expect(x.db.prepare("SELECT COUNT(*) AS count FROM adapter_suppression").get()).toEqual({ count: 0 });
});

test("scheduler bounds ordered batches and leaves the suffix pending", async () => {
  const db = openDatabase(":memory:"); databases.push(db);
  const service = new BrokerService(db, { now: () => 100, randomId: (prefix) => `${prefix}-${Math.random()}`, config: { maxBatchCount: 3, maxBatchEncodedBytes: 16_384 } });
  service.syncProject({ operationId: "s", adminId: "x", workspaceId: "w", rootPath: "C:/r", manifest: { projectId: "p", projectKey: "p", displayName: "P", manifestHash: "h", manifestVersion: 1, lanes: [{ name: "a", roleFile: "a", communicationEntry: true }, { name: "b", roleFile: "b", communicationEntry: false }] } });
  service.bind({ operationId: "a", adminId: "x", bindingId: "ba", laneAddress: "p/a", workspaceId: "w", adapter: "codex", conversationId: "a" });
  service.bind({ operationId: "b", adminId: "x", bindingId: "bb", laneAddress: "p/b", workspaceId: "w", adapter: "codex", conversationId: "b" });
  const sent = Array.from({ length: 7 }, (_, index) => service.send({ operationId: `batch-limit-${index}`, actor: { bindingId: "ba", generation: 1 }, target: "p/b", kind: "normal", body: `${index}`, metadata: {} }));
  const adapter = new FakeAdapter("started_new_turn", "idle");
  const scheduler = new Scheduler(db, { codex: adapter, claude: adapter }, service.config, { now: () => 100, random: () => 0.5 });
  for (const expected of [sent.slice(0, 3), sent.slice(3, 6), sent.slice(6)]) {
    await scheduler.runOnce();
    expect(adapter.requests.at(-1)?.deliveryIds).toEqual(expected.map((item) => item.deliveryId));
    db.prepare(`UPDATE delivery SET state='acknowledged',deadline_kind=NULL,deadline_at=NULL,adapter_result=NULL,next_attempt_at=NULL,park_reason=NULL WHERE id IN (${expected.map(() => "?").join(",")})`).run(...expected.map((item) => item.deliveryId));
    scheduler.setLaneBusy("p/b", false); adapter.setTurn("idle");
  }
  expect(adapter.requests).toHaveLength(3);
});

test("scheduler enforces the encoded-byte limit without omitting FIFO order", async () => {
  const x = setup("started_new_turn");
  const sent = [0, 1, 2].map((index) => x.service.send({ operationId: `byte-limit-${index}`, actor: { bindingId: "ba", generation: 1 }, target: "p/b", kind: "normal", body: `${index}`, metadata: {} }));
  const twoBytes = Buffer.byteLength(JSON.stringify({ deliveryIds: sent.slice(0, 2).map((item) => item.deliveryId), messageIds: sent.slice(0, 2).map((item) => item.messageId) }), "utf8");
  const scheduler = new Scheduler(x.db, { codex: x.adapter, claude: x.adapter }, { ...x.service.config, maxBatchCount: 10, maxBatchEncodedBytes: twoBytes });
  await scheduler.runOnce();
  expect(x.adapter.requests[0]?.deliveryIds).toEqual(sent.slice(0, 2).map((item) => item.deliveryId));
  expect(x.db.prepare("SELECT state FROM delivery WHERE id=?").get(sent[2]!.deliveryId)).toEqual({ state: "pending" });
});

test("an individually oversized frame is failed closed without poisoning its suffix", async () => {
  const x = setup("started_new_turn");
  const sent = [0, 1].map((index) => x.service.send({ operationId: `oversized-${index}`, actor: { bindingId: "ba", generation: 1 }, target: "p/b", kind: "normal", body: `${index}`, metadata: {} }));
  const scheduler = new Scheduler(x.db, { codex: x.adapter, claude: x.adapter }, { ...x.service.config, failureLimit: 1, maxBatchCount: 10, maxBatchEncodedBytes: 1 });
  await scheduler.runOnce();
  await scheduler.runOnce();
  expect(x.adapter.requests).toHaveLength(0);
  expect(x.db.prepare("SELECT id,state FROM delivery ORDER BY sequence").all()).toEqual(sent.map((item) => ({ id: item.deliveryId, state: "parked" })));
});

test("idle lane batches ordered ids and persists a claim deadline", async () => {
  const x = setup("started_new_turn");
  x.service.send({
    operationId: "m1",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "one",
    metadata: {},
  });
  x.service.send({
    operationId: "m2",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "two",
    metadata: {},
  });
  await x.scheduler.runOnce();
  expect(x.adapter.requests).toHaveLength(1);
  expect(x.adapter.requests[0]?.deliveryIds).toHaveLength(2);
  expect(
    (
      x.db
        .prepare("SELECT deadline_kind FROM delivery ORDER BY sequence LIMIT 1")
        .get() as { deadline_kind: string }
    ).deadline_kind,
  ).toBe("claim");
});
test("busy normal waits while correction steers", async () => {
  const x = setup("applied_current_turn");
  x.scheduler.setLaneBusy("p/b", true);
  x.service.send({
    operationId: "n",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "n",
    metadata: {},
  });
  x.service.send({
    operationId: "c",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "correction",
    body: "c",
    metadata: {},
  });
  await x.scheduler.runOnce();
  expect(x.adapter.requests).toHaveLength(1);
  expect(x.adapter.requests[0]?.kind).toBe("correction");
});
test("adapter failures back off and poison deliveries park", async () => {
  const x = setup("adapter_failed");
  const sent = x.service.send({
    operationId: "m",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "x",
    metadata: {},
  });
  for (let i = 0; i < 5; i++) {
    await x.scheduler.runOnce();
    const row = x.db
      .prepare("SELECT next_attempt_at FROM delivery WHERE id=?")
      .get(sent.deliveryId) as { next_attempt_at: number | null };
    if (row.next_attempt_at) x.setNow(row.next_attempt_at);
  }
  expect(x.service.status()).toMatchObject({ pending: { count: 0 } });
  expect(
    (
      x.db
        .prepare("SELECT state FROM delivery WHERE id=?")
        .get(sent.deliveryId) as { state: string }
    ).state,
  ).toBe("parked");
});
test("queued work expires without failure and becomes schedulable again", async () => {
  const x = setup("queued_next_turn");
  const sent = x.service.send({
    operationId: "q",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "q",
    metadata: {},
  });
  await x.scheduler.runOnce();
  x.setNow(3_600_101);
  await x.scheduler.runOnce();
  expect(x.adapter.requests).toHaveLength(2);
  expect(
    (
      x.db
        .prepare("SELECT failure_count FROM delivery WHERE id=?")
        .get(sent.deliveryId) as { failure_count: number }
    ).failure_count,
  ).toBe(0);
});
test("binding_not_found durably unbinds without counting a failure", async () => {
  const x = setup("binding_not_found");
  const sent = x.service.send({
    operationId: "u",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "u",
    metadata: {},
  });
  await x.scheduler.runOnce();
  expect(
    (
      x.db.prepare("SELECT state FROM binding WHERE id='bb'").get() as {
        state: string;
      }
    ).state,
  ).toBe("unbound");
  expect(x.service.status()).toMatchObject({ pending: { count: 1 } });
  expect(
    (
      x.db
        .prepare("SELECT failure_count FROM delivery WHERE id=?")
        .get(sent.deliveryId) as { failure_count: number }
    ).failure_count,
  ).toBe(0);
});

test("a Router-started turn keeps its lane serialized until orchestration marks it idle", async () => {
  const x = setup("started_new_turn");
  const first = x.service.send({
    operationId: "one",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "one",
    metadata: {},
  });
  await x.scheduler.runOnce();
  x.service.send({
    operationId: "two",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "two",
    metadata: {},
  });
  await x.scheduler.runOnce();
  expect(x.adapter.requests).toHaveLength(1);
  x.scheduler.setLaneBusy("p/b", false);
  x.adapter.setTurn("idle");
  const failed = x.scheduler.turnEndedBeforeClaim(first.deliveryId) as {
    nextAttemptAt: number;
  };
  x.setNow(failed.nextAttemptAt);
  await x.scheduler.runOnce();
  expect(x.adapter.requests).toHaveLength(2);
});

test("a started turn ending before claim records failure and releases lane serialization", async () => {
  const x = setup("started_new_turn");
  const sent = x.service.send({
    operationId: "end",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "work",
    metadata: {},
  });
  await x.scheduler.runOnce();
  const failed = x.scheduler.turnEndedBeforeClaim(sent.deliveryId);
  expect(failed).toMatchObject({ status: "pending", failureCount: 1 });
  const nextAttempt = (failed as { nextAttemptAt: number }).nextAttemptAt;
  x.setNow(nextAttempt);
  x.adapter.setTurn("idle");
  await x.scheduler.runOnce();
  expect(x.adapter.requests).toHaveLength(2);
});

test("offline or explicitly unbound lanes remain pending without adapter calls", async () => {
  const x = setup("started_new_turn");
  x.service.unbind({
    operationId: "offline",
    adminId: "x",
    laneAddress: "p/b",
    reason: "offline",
  });
  x.service.send({
    operationId: "pending-offline",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "wait",
    metadata: {},
  });
  await x.scheduler.runOnce();
  expect(x.adapter.requests).toHaveLength(0);
  expect(x.service.status()).toMatchObject({ pending: { count: 1 } });
});

test("claim lease expiry is recovered as a failure with deterministic backoff", async () => {
  const x = setup("started_new_turn");
  const sent = x.service.send({
    operationId: "lease",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "lease",
    metadata: {},
  });
  await x.scheduler.runOnce();
  x.service.claim({
    operationId: "claim-lease",
    actor: { bindingId: "bb", generation: 1 },
    deliveryId: sent.deliveryId,
  });
  x.setNow(600_101);
  await x.scheduler.runOnce();
  expect(
    x.db
      .prepare(
        "SELECT state,failure_count,next_attempt_at FROM delivery WHERE id=?",
      )
      .get(sent.deliveryId),
  ).toMatchObject({
    state: "pending",
    failure_count: 1,
    next_attempt_at: 602_101,
  });
});

test("different lanes deliver in parallel", async () => {
  const x = setup("stored_pending");
  x.db
    .prepare(
      "INSERT INTO lane(id,project_id,name,role_document,communication_entry) VALUES('p/c','p','c','c',0)",
    )
    .run();
  x.db
    .prepare(
      "INSERT INTO binding(id,lane_id,workspace_id,adapter,conversation_id,generation,active_at,inactive_at,inactive_reason,is_current,state,state_changed_at,state_reason) VALUES('bc','p/c','w','codex','c',1,100,NULL,NULL,1,'bound',NULL,NULL)",
    )
    .run();
  x.service.send({
    operationId: "parallel-b",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "b",
    metadata: {},
  });
  x.service.send({
    operationId: "parallel-c",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/c",
    kind: "normal",
    body: "c",
    metadata: {},
  });
  let active = 0;
  let maximum = 0;
  const adapter: DeliveryAdapter = {
    deliver: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return "stored_pending";
    },
    getRuntimeState: async () => ({ availability: "online", turn: "idle" }),
  };
  await new Scheduler(
    x.db,
    { codex: adapter, claude: adapter },
    x.service.config,
    { now: () => 100, random: () => 0.5 },
  ).runOnce();
  expect(maximum).toBe(2);
});

test("an older backed-off normal blocks a later eligible normal", async () => {
  const x = setup("adapter_failed");
  x.service.send({
    operationId: "blocked-first",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "first",
    metadata: {},
  });
  await x.scheduler.runOnce();
  x.service.send({
    operationId: "blocked-second",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "second",
    metadata: {},
  });
  await x.scheduler.runOnce();
  expect(x.adapter.requests).toHaveLength(1);
});

test("a fresh scheduler respects durable notified work and adapter busy state", async () => {
  const x = setup("started_new_turn");
  x.service.send({
    operationId: "restart-first",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "first",
    metadata: {},
  });
  await x.scheduler.runOnce();
  x.service.send({
    operationId: "restart-second",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "second",
    metadata: {},
  });
  const runtimeAdapter: DeliveryAdapter = {
    deliver: (request) => x.adapter.deliver(request),
    getRuntimeState: async () => ({ availability: "online", turn: "busy" }),
  };
  await new Scheduler(
    x.db,
    { codex: runtimeAdapter, claude: runtimeAdapter },
    x.service.config,
    { now: () => 100, random: () => 0.5 },
  ).runOnce();
  expect(x.adapter.requests).toHaveLength(1);
});

test("acknowledged work does not erase a still-busy turn across scheduler restart", async () => {
  const x = setup("started_new_turn");
  const first = x.service.send({
    operationId: "ack-busy-first",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "first",
    metadata: {},
  });
  await x.scheduler.runOnce();
  const claim = x.service.claim({
    operationId: "ack-busy-claim",
    actor: { bindingId: "bb", generation: 1 },
    deliveryId: first.deliveryId,
  });
  x.service.ack({
    operationId: "ack-busy-ack",
    actor: { bindingId: "bb", generation: 1 },
    deliveryId: first.deliveryId,
    claimId: claim.claimId,
    outcome: { kind: "recorded", summary: "done" },
  });
  x.service.send({
    operationId: "ack-busy-second",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "second",
    metadata: {},
  });
  let turn: "busy" | "idle" = "busy";
  const adapter: DeliveryAdapter = {
    deliver: (request) => x.adapter.deliver(request),
    getRuntimeState: async () => ({ availability: "online", turn }),
  };
  const restarted = new Scheduler(
    x.db,
    { codex: adapter, claude: adapter },
    x.service.config,
    { now: () => 100, random: () => 0.5 },
  );
  await restarted.runOnce();
  expect(x.adapter.requests).toHaveLength(1);
  turn = "idle";
  await restarted.runOnce();
  expect(x.adapter.requests).toHaveLength(2);
});

test("runtime-state probe failures degrade a lane without failing its delivery", async () => {
  const x = setup("started_new_turn");
  const sent = x.service.send({
    operationId: "probe-failure",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "wait",
    metadata: {},
  });
  let failuresRemaining = 2;
  let deliveries = 0;
  const adapter: DeliveryAdapter = {
    deliver: async () => {
      deliveries += 1;
      return "started_new_turn";
    },
    getRuntimeState: async () => {
      if (failuresRemaining-- > 0) throw new Error("SECRET PROBE FAILURE");
      return { availability: "online", turn: "idle" };
    },
  };
  const scheduler = new Scheduler(
    x.db,
    { codex: adapter, claude: adapter },
    x.service.config,
    { now: () => 100, random: () => 0.5 },
  );
  await expect(scheduler.runOnce()).resolves.toBe(1);
  await expect(scheduler.runOnce()).resolves.toBe(1);
  expect(deliveries).toBe(0);
  expect(
    x.db
      .prepare("SELECT state,failure_count FROM delivery WHERE id=?")
      .get(sent.deliveryId),
  ).toEqual({ state: "pending", failure_count: 0 });
  const failureEvents = x.service
    .events()
    .filter((event) => event.type === "adapter_runtime_state_failed");
  expect(failureEvents).toHaveLength(2);
  expect(JSON.stringify(failureEvents)).not.toContain("SECRET PROBE FAILURE");
  await expect(scheduler.runOnce()).resolves.toBe(1);
  expect(deliveries).toBe(1);
});

test("offline observation is durably suppressed until explicit reconnect", async () => {
  const x = setup("started_new_turn");
  x.service.send({
    operationId: "offline-pending",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "wait",
    metadata: {},
  });
  let online = false;
  let healthChecks = 0;
  let deliveries = 0;
  const adapter: DeliveryAdapter = {
    deliver: async () => {
      deliveries += 1;
      return "started_new_turn";
    },
    getRuntimeState: async () => {
      healthChecks += 1;
      return online
        ? { availability: "online", turn: "idle" }
        : { availability: "offline", turn: "unknown" };
    },
  };
  const scheduler = new Scheduler(
    x.db,
    { codex: adapter, claude: adapter },
    x.service.config,
    { now: () => 100, random: () => 0.5 },
  );
  await scheduler.runOnce();
  await scheduler.runOnce();
  await scheduler.runOnce();
  expect(deliveries).toBe(0);
  expect(healthChecks).toBe(1);
  online = true;
  x.service.notifyAdapterAvailable({
    operationId: "offline-reconnected", adminId: "admin", laneId: "p/b",
  });
  await scheduler.runOnce();
  expect(deliveries).toBe(1);
});

test("an older claimed normal blocks later normals after scheduler restart", async () => {
  const x = setup("started_new_turn");
  const first = x.service.send({
    operationId: "claimed-first",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "first",
    metadata: {},
  });
  x.service.claim({
    operationId: "claimed",
    actor: { bindingId: "bb", generation: 1 },
    deliveryId: first.deliveryId,
  });
  x.service.send({
    operationId: "claimed-second",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "second",
    metadata: {},
  });
  const adapter = new FakeAdapter("started_new_turn", "idle");
  await new Scheduler(
    x.db,
    { codex: adapter, claude: adapter },
    x.service.config,
    { now: () => 100, random: () => 0.5 },
  ).runOnce();
  expect(adapter.requests).toHaveLength(0);
});

test("an older backed-off correction blocks later corrections but not normal FIFO", async () => {
  const x = setup("adapter_failed");
  x.service.send({
    operationId: "correction-first",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "correction",
    body: "first",
    metadata: {},
  });
  await x.scheduler.runOnce();
  x.service.send({
    operationId: "correction-second",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "correction",
    body: "second",
    metadata: {},
  });
  x.service.send({
    operationId: "normal-independent",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "normal",
    metadata: {},
  });
  await x.scheduler.runOnce();
  expect(x.adapter.requests).toHaveLength(2);
  expect(x.adapter.requests[1]?.kind).toBe("normal");
});

test("stored_pending suppression survives scheduler restart until an explicit reconnect", async () => {
  const x = setup("stored_pending");
  x.service.send({
    operationId: "stored",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "wait",
    metadata: {},
  });
  await x.scheduler.runOnce();
  const restarted = new Scheduler(
    x.db,
    { codex: x.adapter, claude: x.adapter },
    x.service.config,
    { now: () => 100, random: () => 0.5 },
  );
  await restarted.runOnce();
  expect(x.adapter.requests).toHaveLength(1);
  expect(x.service.notifyAdapterAvailable({
    operationId: "adapter-reconnected", adminId: "admin", laneId: "p/b",
  })).toEqual({ laneId: "p/b", cleared: true });
  await restarted.runOnce();
  expect(x.adapter.requests).toHaveLength(2);
});

test("retry permits a new ambiguous attempt and the new fence survives restart", async () => {
  const x = setup("queued_next_turn");
  const sent = x.service.send({
    operationId: "repeatable-fence-send", actor: { bindingId: "ba", generation: 1 },
    target: "p/b", kind: "normal", body: "ambiguous", metadata: {},
  });
  x.db.exec(`
    CREATE TRIGGER fail_repeatable_adapter_event
    BEFORE INSERT ON event
    WHEN NEW.event_type='adapter_result' AND NEW.delivery_id='${sent.deliveryId}'
    BEGIN SELECT RAISE(ABORT, 'injected repeated ambiguity'); END;
  `);
  await expect(x.scheduler.runOnce()).rejects.toBeInstanceOf(AggregateError);
  const first = x.db.prepare(`
    SELECT fence_id FROM dispatch_fence WHERE delivery_id=? AND resolved_at IS NULL
  `).get(sent.deliveryId) as { fence_id: string };
  expect(x.service.resolveDispatchFence({
    operationId: "retry-first-attempt", adminId: "admin",
    fenceId: first.fence_id, resolution: "retry",
  })).toEqual({ fenceId: first.fence_id, deliveryId: sent.deliveryId, resolution: "retry" });

  await expect(x.scheduler.runOnce()).rejects.toBeInstanceOf(AggregateError);
  const attempts = x.db.prepare(`
    SELECT fence_id,resolution FROM dispatch_fence WHERE delivery_id=? ORDER BY created_at,fence_id
  `).all(sent.deliveryId) as Array<{ fence_id: string; resolution: string | null }>;
  expect(attempts).toHaveLength(2);
  expect(attempts.find((attempt) => attempt.fence_id === first.fence_id)?.resolution).toBe("retry");
  const active = attempts.find((attempt) => attempt.resolution === null);
  expect(active?.fence_id).not.toBe(first.fence_id);

  const restarted = new Scheduler(
    x.db, { codex: x.adapter, claude: x.adapter }, x.service.config,
    { now: () => 100, random: () => 0.5 },
  );
  await expect(restarted.runOnce()).resolves.toBe(0);
  expect(x.adapter.requests).toHaveLength(2);
});

test("overlapping runOnce calls acquire the lane before awaiting runtime state", async () => {
  const x = setup("stored_pending");
  x.service.send({
    operationId: "overlap",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "once",
    metadata: {},
  });
  let releaseProbe!: () => void;
  const probeBlocked = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let enteredProbe!: () => void;
  const probeEntered = new Promise<void>((resolve) => {
    enteredProbe = resolve;
  });
  let probes = 0;
  let deliveries = 0;
  const adapter: DeliveryAdapter = {
    getRuntimeState: async () => {
      probes += 1;
      enteredProbe();
      await probeBlocked;
      return { availability: "online", turn: "idle" };
    },
    deliver: async () => {
      deliveries += 1;
      return "stored_pending";
    },
  };
  const scheduler = new Scheduler(
    x.db,
    { codex: adapter, claude: adapter },
    x.service.config,
    { now: () => 100, random: () => 0.5 },
  );
  const first = scheduler.runOnce();
  await probeEntered;
  const second = scheduler.runOnce();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseProbe();
  const results = await Promise.allSettled([first, second]);
  expect(results.every((result) => result.status === "fulfilled")).toBe(true);
  expect(probes).toBe(1);
  expect(deliveries).toBe(1);
});

test("turn-ended persistence rolls back with its event while other lanes continue", async () => {
  const x = setup("started_new_turn");
  const first = x.service.send({
    operationId: "atomic-turn-ended",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "first",
    metadata: {},
  });
  await x.scheduler.runOnce();
  x.db.exec(`
    INSERT INTO lane(id,project_id,name,role_document,communication_entry)
      VALUES('p/c','p','c','c',0);
    INSERT INTO binding(
      id,lane_id,workspace_id,adapter,conversation_id,generation,active_at,
      inactive_at,inactive_reason,is_current,state,state_changed_at,state_reason
    ) VALUES('bc','p/c','w','codex','c',1,100,NULL,NULL,1,'bound',NULL,NULL);
    CREATE TRIGGER fail_turn_ended_event
    BEFORE INSERT ON event
    WHEN NEW.event_type='turn_ended_before_claim'
    BEGIN
      SELECT RAISE(ABORT, 'injected turn-ended event failure');
    END;
  `);
  x.service.send({
    operationId: "unrelated-lane",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/c",
    kind: "normal",
    body: "unrelated",
    metadata: {},
  });
  const deliveredLanes: string[] = [];
  const adapter: DeliveryAdapter = {
    getRuntimeState: async () => ({ availability: "online", turn: "idle" }),
    deliver: async (request) => {
      deliveredLanes.push(request.targetLaneId);
      return "stored_pending";
    },
  };
  const scheduler = new Scheduler(
    x.db,
    { codex: adapter, claude: adapter },
    x.service.config,
    { now: () => 100, random: () => 0.5 },
  );
  await expect(scheduler.runOnce()).rejects.toBeInstanceOf(AggregateError);
  expect(deliveredLanes).toEqual(["p/c"]);
  expect(
    x.db
      .prepare("SELECT state,failure_count FROM delivery WHERE id=?")
      .get(first.deliveryId),
  ).toEqual({ state: "notified", failure_count: 0 });
  expect(
    x.service
      .events()
      .filter((event) => event.type === "turn_ended_before_claim"),
  ).toHaveLength(0);
});

test("post-adapter persistence failure fences ambiguous delivery across restart", async () => {
  const x = setup("queued_next_turn");
  const ambiguous = x.service.send({
    operationId: "ambiguous-send",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "ambiguous",
    metadata: {},
  });
  x.db.exec(`
    INSERT INTO lane(id,project_id,name,role_document,communication_entry)
      VALUES('p/c','p','c','c',0);
    INSERT INTO binding(
      id,lane_id,workspace_id,adapter,conversation_id,generation,active_at,
      inactive_at,inactive_reason,is_current,state,state_changed_at,state_reason
    ) VALUES('bc','p/c','w','codex','c',1,100,NULL,NULL,1,'bound',NULL,NULL);
  `);
  const unrelated = x.service.send({
    operationId: "unrelated-send",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/c",
    kind: "normal",
    body: "unrelated",
    metadata: {},
  });
  x.db.exec(`
    CREATE TRIGGER fail_ambiguous_adapter_event
    BEFORE INSERT ON event
    WHEN NEW.event_type='adapter_result' AND NEW.delivery_id='${ambiguous.deliveryId}'
    BEGIN SELECT RAISE(ABORT, 'injected post-adapter persistence failure'); END;
  `);
  const delivered: string[] = [];
  const adapter: DeliveryAdapter = {
    getRuntimeState: async () => ({ availability: "online", turn: "idle" }),
    deliver: async (request) => {
      delivered.push(request.targetLaneId);
      return "queued_next_turn";
    },
  };
  const scheduler = new Scheduler(
    x.db,
    { codex: adapter, claude: adapter },
    x.service.config,
    { now: () => 100, random: () => 0.5 },
  );
  await expect(scheduler.runOnce()).rejects.toBeInstanceOf(AggregateError);
  expect(delivered.sort()).toEqual(["p/b", "p/c"]);
  expect(x.db.prepare("SELECT state FROM delivery WHERE id=?").get(ambiguous.deliveryId)).toEqual({ state: "pending" });
  expect(x.db.prepare("SELECT state FROM delivery WHERE id=?").get(unrelated.deliveryId)).toEqual({ state: "notified" });
  expect(x.db.prepare("SELECT lane_id,adapter_outcome,reason_code,resolved_at FROM dispatch_fence WHERE delivery_id=?").get(ambiguous.deliveryId)).toEqual({
    lane_id: "p/b",
    adapter_outcome: "queued_next_turn",
    reason_code: "post_adapter_persistence_failed",
    resolved_at: null,
  });
  await expect(scheduler.runOnce()).resolves.toBe(1);
  await expect(new Scheduler(
    x.db,
    { codex: adapter, claude: adapter },
    x.service.config,
    { now: () => 100, random: () => 0.5 },
  ).runOnce()).resolves.toBe(1);
  expect(delivered.filter((lane) => lane === "p/b")).toHaveLength(1);
});

test("failure to persist an ambiguity fence fatally stops scheduling", async () => {
  const x = setup("queued_next_turn");
  const sent = x.service.send({
    operationId: "fatal-fence-send",
    actor: { bindingId: "ba", generation: 1 },
    target: "p/b",
    kind: "normal",
    body: "fatal",
    metadata: {},
  });
  x.db.exec(`
    CREATE TRIGGER fail_adapter_result_for_fatal
    BEFORE INSERT ON event WHEN NEW.event_type='adapter_result'
    BEGIN SELECT RAISE(ABORT, 'adapter persistence failed'); END;
    CREATE TRIGGER fail_dispatch_fence
    BEFORE INSERT ON dispatch_fence
    BEGIN SELECT RAISE(ABORT, 'fence persistence failed'); END;
  `);
  let deliveries = 0;
  let fatal: Error | undefined;
  const adapter: DeliveryAdapter = {
    getRuntimeState: async () => ({ availability: "online", turn: "idle" }),
    deliver: async () => { deliveries += 1; return "queued_next_turn"; },
  };
  const scheduler = new Scheduler(
    x.db,
    { codex: adapter, claude: adapter },
    x.service.config,
    { now: () => 100, random: () => 0.5, onFatal: (error) => { fatal = error; } },
  );
  await expect(scheduler.runOnce()).rejects.toBeInstanceOf(AggregateError);
  expect(fatal?.message).toMatch(/fence persistence failed/i);
  await expect(scheduler.runOnce()).rejects.toBe(fatal);
  expect(deliveries).toBe(1);
  expect(x.db.prepare("SELECT state FROM delivery WHERE id=?").get(sent.deliveryId)).toEqual({ state: "pending" });
});

test("explicit operation-backed reconciliation clears or settles dispatch fences idempotently", async () => {
  const x = setup("queued_next_turn");
  const retry = x.service.send({
    operationId: "retry-fenced-send", actor: { bindingId: "ba", generation: 1 },
    target: "p/b", kind: "normal", body: "retry", metadata: {},
  });
  x.db.prepare(`INSERT INTO dispatch_fence(fence_id,delivery_id,lane_id,adapter_outcome,created_at,reason_code)
    VALUES('fence-retry', ?, 'p/b', 'queued_next_turn', 100, 'post_adapter_persistence_failed')`).run(retry.deliveryId);
  expect(() => x.service.resolveDispatchFence({
    operationId: "resolve-unauthorized", adminId: "", fenceId: "fence-retry", resolution: "retry",
  })).toThrow(/admin identity/i);
  expect(x.service.resolveDispatchFence({
    operationId: "resolve-retry", adminId: "admin", fenceId: "fence-retry", resolution: "retry",
  })).toEqual({ fenceId: "fence-retry", deliveryId: retry.deliveryId, resolution: "retry" });
  expect(() => x.service.resolveDispatchFence({
    operationId: "resolve-retry-stale", adminId: "admin", fenceId: "fence-retry", resolution: "retry",
  })).toThrow(/missing|already resolved/i);
  expect(x.service.resolveDispatchFence({
    operationId: "resolve-retry", adminId: "admin", fenceId: "fence-retry", resolution: "retry",
  })).toEqual({ fenceId: "fence-retry", deliveryId: retry.deliveryId, resolution: "retry" });

  const settled = x.service.send({
    operationId: "settle-fenced-send", actor: { bindingId: "ba", generation: 1 },
    target: "p/b", kind: "normal", body: "settle", metadata: {},
  });
  x.db.prepare(`INSERT INTO dispatch_fence(fence_id,delivery_id,lane_id,adapter_outcome,created_at,reason_code)
    VALUES('fence-settled', ?, 'p/b', 'queued_next_turn', 100, 'post_adapter_persistence_failed')`).run(settled.deliveryId);
  expect(x.service.resolveDispatchFence({
    operationId: "resolve-settled", adminId: "admin", fenceId: "fence-settled", resolution: "settled",
  })).toEqual({ fenceId: "fence-settled", deliveryId: settled.deliveryId, resolution: "settled" });
  expect(x.db.prepare("SELECT state FROM delivery WHERE id=?").get(settled.deliveryId)).toEqual({ state: "notified" });
  expect(x.db.prepare("SELECT resolution,resolution_operation_id FROM dispatch_fence ORDER BY delivery_id").all()).toEqual([
    { resolution: "retry", resolution_operation_id: "resolve-retry" },
    { resolution: "settled", resolution_operation_id: "resolve-settled" },
  ]);
});

test("settled reconciliation uses normal adapter-result binding and suppression semantics", () => {
  const missing = setup("binding_not_found");
  const missingDelivery = missing.service.send({
    operationId: "settled-missing-send", actor: { bindingId: "ba", generation: 1 },
    target: "p/b", kind: "normal", body: "missing", metadata: {},
  });
  missing.db.prepare(`INSERT INTO dispatch_fence(
    fence_id,delivery_id,lane_id,adapter_outcome,created_at,reason_code
  ) VALUES('fence-missing',?,'p/b','binding_not_found',100,'post_adapter_persistence_failed')`).run(missingDelivery.deliveryId);
  missing.service.resolveDispatchFence({
    operationId: "settle-missing", adminId: "admin", fenceId: "fence-missing", resolution: "settled",
  });
  expect(missing.db.prepare("SELECT state FROM binding WHERE id='bb'").get()).toEqual({ state: "unbound" });
  expect(missing.db.prepare("SELECT state,failure_count FROM delivery WHERE id=?").get(missingDelivery.deliveryId)).toEqual({
    state: "pending", failure_count: 0,
  });

  const stored = setup("stored_pending");
  const storedDelivery = stored.service.send({
    operationId: "settled-stored-send", actor: { bindingId: "ba", generation: 1 },
    target: "p/b", kind: "normal", body: "stored", metadata: {},
  });
  stored.db.prepare(`INSERT INTO dispatch_fence(
    fence_id,delivery_id,lane_id,adapter_outcome,created_at,reason_code
  ) VALUES('fence-stored',?,'p/b','stored_pending',100,'post_adapter_persistence_failed')`).run(storedDelivery.deliveryId);
  stored.service.resolveDispatchFence({
    operationId: "settle-stored", adminId: "admin", fenceId: "fence-stored", resolution: "settled",
  });
  expect(stored.db.prepare("SELECT reason_code FROM adapter_suppression WHERE lane_id='p/b'").get()).toEqual({
    reason_code: "stored_pending",
  });
  expect(stored.service.events().filter((event) => event.type === "adapter_result")).toHaveLength(1);
});
