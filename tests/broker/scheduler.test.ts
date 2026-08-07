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

test("offline health polling suppresses delivery until reconnect", async () => {
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
  expect(healthChecks).toBe(3);
  online = true;
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

test("stored_pending suppresses repeated delivery until an availability signal", async () => {
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
  await x.scheduler.runOnce();
  expect(x.adapter.requests).toHaveLength(1);
  x.scheduler.setLaneAvailable("p/b", true);
  await x.scheduler.runOnce();
  expect(x.adapter.requests).toHaveLength(2);
});
