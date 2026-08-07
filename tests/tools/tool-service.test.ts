import { afterEach, expect, test } from "vitest";
import { BrokerService } from "../../src/broker/broker-service.js";
import {
  openDatabase,
  type RouterDatabase,
} from "../../src/storage/database.js";
import { LANE_TOOL_NAMES } from "../../src/tools/tool-contract.js";
import { ToolService } from "../../src/tools/tool-service.js";
const databases: RouterDatabase[] = [];
afterEach(() => databases.splice(0).forEach((d) => d.close()));
function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const broker = new BrokerService(db, { now: () => 100, randomId: (p) => p });
  broker.syncProject({
    operationId: "s",
    adminId: "x",
    workspaceId: "w",
    rootPath: "C:/r",
    manifest: {
      projectId: "p",
      projectKey: "p",
      displayName: "P",
      manifestHash: "h",
      manifestVersion: 1,
      lanes: [
        { name: "a", roleFile: "a", communicationEntry: true },
        { name: "b", roleFile: "b", communicationEntry: false },
      ],
    },
  });
  broker.bind({
    operationId: "a",
    adminId: "x",
    bindingId: "ba",
    laneAddress: "p/a",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "a",
  });
  broker.bind({
    operationId: "b",
    adminId: "x",
    bindingId: "bb",
    laneAddress: "p/b",
    workspaceId: "w",
    adapter: "codex",
    conversationId: "b",
  });
  return { broker, tools: new ToolService(broker) };
}
test("exports exactly the eight logical tools", () =>
  expect(LANE_TOOL_NAMES).toEqual([
    "lane_whoami",
    "lane_status",
    "lane_send",
    "lane_inbox_list",
    "lane_message_get",
    "lane_message_claim",
    "lane_message_ack",
    "lane_message_park",
  ]));
test("tool identity comes only from immutable binding context", async () => {
  const x = setup();
  const a = { bindingId: "ba", generation: 1 };
  const b = { bindingId: "bb", generation: 1 };
  expect(await x.tools.call("lane_whoami", {}, a)).toMatchObject({
    laneAddress: "p/a",
  });
  const sent = (await x.tools.call(
    "lane_send",
    {
      operation_id: "send",
      target: "p/b",
      kind: "normal",
      body: "hello",
      metadata: {},
    },
    a,
  )) as { messageId: string; deliveryId: string };
  expect(await x.tools.call("lane_inbox_list", {}, b)).toHaveLength(1);
  expect(
    await x.tools.call("lane_message_get", { message_id: sent.messageId }, b),
  ).toMatchObject({ body: "hello" });
  const claim = (await x.tools.call(
    "lane_message_claim",
    { operation_id: "claim", delivery_id: sent.deliveryId },
    b,
  )) as { claimId: string };
  expect(
    await x.tools.call(
      "lane_message_ack",
      {
        operation_id: "ack",
        delivery_id: sent.deliveryId,
        claim_id: claim.claimId,
        outcome: { kind: "rejected", reason: "not mine" },
      },
      b,
    ),
  ).toMatchObject({ status: "acknowledged" });
  expect(() =>
    x.tools.call(
      "lane_send",
      {
        operation_id: "evil",
        bindingId: "bb",
        generation: 1,
        target: "p/a",
        kind: "normal",
        body: "spoof",
        metadata: {},
      },
      a,
    ),
  ).toThrow(/unrecognized/i);
  expect(() =>
    x.tools.call("lane_whoami", {}, { bindingId: "ba", generation: 2 }),
  ).toThrow(/stale/i);
});
test("status and park tools operate on the current target binding", async () => {
  const x = setup();
  const a = { bindingId: "ba", generation: 1 };
  const b = { bindingId: "bb", generation: 1 };
  const sent = (await x.tools.call(
    "lane_send",
    {
      operation_id: "s2",
      target: "p/b",
      kind: "normal",
      body: "x",
      metadata: {},
    },
    a,
  )) as { deliveryId: string };
  expect(await x.tools.call("lane_status", {}, b)).toBeTruthy();
  expect(
    await x.tools.call(
      "lane_message_park",
      { operation_id: "p", delivery_id: sent.deliveryId, reason: "later" },
      b,
    ),
  ).toMatchObject({ status: "parked" });
});

test.each([
  ["lane_send", { operation_id: "bad-kind", target: "p/b", kind: "typo", body: "x", metadata: {} }],
  ["lane_send", { operation_id: "extra", target: "p/b", kind: "normal", body: "x", metadata: {}, extra: true }],
  ["lane_message_ack", { operation_id: "bad-outcome", delivery_id: "d", claim_id: "c", outcome: { kind: "recorded" } }],
] as const)("rejects invalid strict %s arguments before durable effects", (name, args) => {
  const x = setup();
  const before = x.broker.database.prepare("SELECT COUNT(*) AS count FROM operation").get();
  expect(() => x.tools.call(name, args, { bindingId: "ba", generation: 1 })).toThrow();
  expect(x.broker.database.prepare("SELECT COUNT(*) AS count FROM operation").get()).toEqual(before);
});

test("validates tool results before returning them", () => {
  const x = setup();
  Object.defineProperty(x.broker, "status", { value: () => ({ pending: { count: -1 } }) });
  expect(() => x.tools.call("lane_status", {}, { bindingId: "ba", generation: 1 })).toThrow();
});
