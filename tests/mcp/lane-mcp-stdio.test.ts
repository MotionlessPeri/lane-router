import { afterEach, expect, test } from "vitest";
import { BrokerService } from "../../src/broker/broker-service.js";
import { BrokerClient } from "../../src/client/broker-client.js";
import { startBrokerHttpServer, type RunningBrokerServer } from "../../src/server/http-server.js";
import { openDatabase, type RouterDatabase } from "../../src/storage/database.js";
import { connectFakeClaude } from "../fixtures/claude/fake-channel-client.mjs";

const servers: RunningBrokerServer[] = [];
const databases: RouterDatabase[] = [];
const clients: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  databases.splice(0).forEach((database) => database.close());
});

test("production stdio entrypoint joins the authenticated bridge and emits a body-free Channel notification", async () => {
  const database = openDatabase(":memory:"); databases.push(database);
  const service = new BrokerService(database, { now: () => 100, randomId: (prefix) => prefix });
  const server = await startBrokerHttpServer({ service, token: "secret", sessionSecret: "session-secret", port: 0 });
  servers.push(server);
  const admin = new BrokerClient(server.url, "secret");
  await admin.call("syncProject", { operationId: "sync", workspaceId: "w", rootPath: "C:/r", manifest: { projectId: "p", projectKey: "p", displayName: "P", manifestHash: "h", manifestVersion: 1, lanes: [{ name: "a", roleFile: "a.md", communicationEntry: true }] } });
  const bound = await admin.call("bind", { operationId: "bind", bindingId: "binding-a", laneAddress: "p/a", workspaceId: "w", adapter: "claude", conversationId: "conversation-a" });

  const fake = await connectFakeClaude({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/lane-mcp-server.ts"],
    cwd: process.cwd(),
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      LANE_ROUTER_URL: server.url,
      LANE_ROUTER_DISCOVERY_TOKEN: "unused-by-binding-client",
      LANE_ROUTER_BINDING_CREDENTIAL: bound.bindingCredential,
      LANE_ROUTER_BINDING_ID: "binding-a",
      LANE_ROUTER_BINDING_GENERATION: "1",
      LANE_ROUTER_CLAUDE_CONNECTION_EPOCH: "stdio-test-epoch",
    },
  });
  clients.push(fake);
  await expect.poll(() => server.claudeChannels.getRuntimeState("binding-a", 1)).toEqual({ availability: "online", turn: "busy" });
  const stopped = await fetch(`${server.url}/v1/adapters/claude/state`, { method: "POST", headers: { authorization: `Session ${bound.bindingCredential}`, "content-type": "application/json" }, body: JSON.stringify({ connectionEpoch: "stdio-test-epoch", event: "Stop" }) });
  expect(await stopped.json()).toEqual({ ok: true, data: { accepted: true } });

  const accepted = server.claudeChannels.deliver("binding-a", 1, { deliveryId: "delivery-1", messageId: "message-1", targetLaneId: "p/a", sequence: 1, kind: "normal", bindingGeneration: 1 });
  const notification = await fake.nextNotification();
  expect(notification.params.meta).toEqual({ message_id: "message-1" });
  expect(JSON.parse(notification.params.content)).toEqual({ deliveryIds: ["delivery-1"], messageIds: ["message-1"], targetLaneId: "p/a", sequence: 1, kind: "normal" });
  expect(notification.params.content).not.toContain("body");
  await expect(accepted).resolves.toBe("started_new_turn");
});
