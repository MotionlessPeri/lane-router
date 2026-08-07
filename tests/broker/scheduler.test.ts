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
  constructor(private readonly result: AdapterResult) {}
  async deliver(request: AdapterDeliveryRequest): Promise<AdapterResult> {
    this.requests.push(request);
    return this.result;
  }
}
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
  const adapter = new FakeAdapter(result);
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
  x.service.send({
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
  };
  await new Scheduler(
    x.db,
    { codex: adapter, claude: adapter },
    x.service.config,
    { now: () => 100, random: () => 0.5 },
  ).runOnce();
  expect(maximum).toBe(2);
});
