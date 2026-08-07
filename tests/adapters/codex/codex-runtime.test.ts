import { afterEach, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { AppServerClient } from "../../../src/adapters/codex/app-server-client.js";
import { CodexRuntime, type CodexProcessControl } from "../../../src/adapters/codex/codex-runtime.js";
import { BrokerService } from "../../../src/broker/broker-service.js";
import { Scheduler } from "../../../src/broker/scheduler.js";
import { openDatabase, type RouterDatabase } from "../../../src/storage/database.js";

const databases: RouterDatabase[] = [];
const servers: ScriptedAppServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  databases.splice(0).forEach((database) => database.close());
});

test("production runtime composes one client/dispatcher across lanes, tools, batches, and reconnect", async () => {
  const server = await ScriptedAppServer.create(); servers.push(server);
  const process = new ScriptedProcess(server.url);
  const db = openDatabase(":memory:"); databases.push(db);
  const broker = brokerFixture(db);
  const runtime = new CodexRuntime({ broker, process, adminId: "runtime-admin" });
  runtime.registerBinding({ laneId: "p/a", bindingId: "ba", generation: 1, threadId: "th-a" });
  runtime.registerBinding({ laneId: "p/b", bindingId: "bb", generation: 1, threadId: "th-b" });

  const clientBeforeStart = runtime.client;
  await runtime.start();
  expect(process.starts).toBe(1);
  expect(runtime.client).toBe(clientBeforeStart);
  expect(runtime.dynamicTools).toHaveLength(8);

  for (let index = 1; index <= 3; index += 1) broker.send({ operationId: `batch-${index}`, actor: { bindingId: "ba", generation: 1 }, target: "p/b", kind: "normal", body: `SECRET-BODY-${index}`, metadata: {} });
  const scheduler = new Scheduler(db, { codex: runtime.adapter, claude: runtime.adapter }, broker.config, { now: () => 100, random: () => 0.5 });
  await scheduler.runOnce();
  expect(server.turnStarts).toHaveLength(1);
  const wakeText = server.turnStarts[0]!.input[0]!.text;
  const wake = JSON.parse(wakeText) as { deliveryIds: string[]; messageIds: string[] };
  expect(wake.deliveryIds).toHaveLength(3);
  expect(wake.messageIds).toHaveLength(3);
  expect(wakeText).not.toContain("SECRET-BODY");

  const whoami = await server.toolCall({ threadId: "th-a", turnId: "turn-tools", callId: "who", tool: "lane_whoami", arguments: {} });
  expect(toolResult(whoami)).toMatchObject({ laneAddress: "p/a", bindingId: "ba" });
  const sendParams = { threadId: "th-a", turnId: "turn-tools", callId: "send-once", tool: "lane_send", arguments: { operation_id: "spoof", target: "p/b", kind: "normal", body: "dynamic", metadata: {}, actor: { bindingId: "bb" } } };
  const [sentA, sentB] = await Promise.all([server.toolCall(sendParams), server.toolCall(sendParams)]);
  expect(toolResult(sentA)).toEqual(toolResult(sentB));
  const inbox = await server.toolCall({ threadId: "th-b", turnId: "turn-tools-b", callId: "inbox", tool: "lane_inbox_list", arguments: {} });
  expect(toolResult(inbox)).toHaveLength(4);

  broker.unbind({ operationId: "unbind-a", adminId: "admin", laneAddress: "p/a", reason: "test stale thread" });
  await expect(server.toolCall({ threadId: "th-a", turnId: "later", callId: "stale", tool: "lane_whoami", arguments: {} })).rejects.toThrow(/stale|unbound/i);

  db.prepare("INSERT INTO adapter_suppression(lane_id,source_delivery_id,created_at,reason_code) VALUES('p/b',NULL,100,'offline')").run();
  process.signalReconnect();
  expect(db.prepare("SELECT COUNT(*) AS count FROM adapter_suppression").get()).toEqual({ count: 0 });
  await runtime.stop();
  expect(process.stops).toBe(1);
});

class ScriptedProcess implements CodexProcessControl {
  readonly client: AppServerClient;
  starts = 0; stops = 0;
  private reconnect?: () => void;
  constructor(url: string) { this.client = new AppServerClient({ url, requestTimeoutMs: 1_000 }); }
  async start(): Promise<string> { this.starts += 1; await this.client.connect(); return "ws://127.0.0.1:fixture"; }
  async shutdown(): Promise<void> { this.stops += 1; await this.client.close(); }
  onReconnect(handler: () => void): () => void { this.reconnect = handler; return () => { this.reconnect = undefined; }; }
  signalReconnect(): void { this.reconnect?.(); }
}

class ScriptedAppServer {
  private socket?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly turnStarts: Array<{ threadId: string; input: Array<{ type: string; text: string }> }> = [];
  private constructor(readonly server: WebSocketServer, readonly url: string) {
    server.on("connection", (socket) => { this.socket = socket; socket.on("message", (raw) => this.receive(JSON.parse(raw.toString()) as Record<string, unknown>, socket)); });
  }
  static async create(): Promise<ScriptedAppServer> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address(); if (typeof address === "string" || address === null) throw new Error("missing fixture port");
    return new ScriptedAppServer(server, `ws://127.0.0.1:${address.port}`);
  }
  toolCall(params: { threadId: string; turnId: string; callId: string; tool: string; arguments: unknown }): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket!.send(JSON.stringify({ id, method: "item/tool/call", params })); });
  }
  close(): Promise<void> { this.socket?.close(); return new Promise((resolve) => this.server.close(() => resolve())); }
  private receive(message: Record<string, unknown>, socket: WebSocket): void {
    if (message.method === "initialize") { socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fake", platformFamily: "windows", platformOs: "windows", codexHome: "tmp" } })); return; }
    if (message.method === "thread/read") { const params = message.params as { threadId: string }; socket.send(JSON.stringify({ id: message.id, result: { thread: { id: params.threadId, status: { type: "idle" }, turns: [] } } })); return; }
    if (message.method === "turn/start") { const params = message.params as { threadId: string; input: Array<{ type: string; text: string }> }; this.turnStarts.push(params); socket.send(JSON.stringify({ id: message.id, result: { turn: { id: `turn-${this.turnStarts.length}`, status: "inProgress", items: [] } } })); return; }
    if (typeof message.id === "number" && !message.method) { const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); const error = message.error as { message: string } | undefined; error ? pending.reject(new Error(error.message)) : pending.resolve(message.result); }
  }
}

function toolResult(response: unknown): unknown {
  const content = response as { success: boolean; contentItems: Array<{ text: string }> };
  expect(content.success).toBe(true);
  return JSON.parse(content.contentItems[0]!.text);
}

function brokerFixture(db: RouterDatabase): BrokerService {
  const broker = new BrokerService(db, { now: () => 100, randomId: (prefix) => `${prefix}-${Math.random()}` });
  broker.syncProject({ operationId: "sync", adminId: "admin", workspaceId: "w", rootPath: "C:/fixture", manifest: { projectId: "p", projectKey: "p", displayName: "P", manifestHash: "h", manifestVersion: 1, lanes: [{ name: "a", roleFile: "a", communicationEntry: true }, { name: "b", roleFile: "b", communicationEntry: false }] } });
  broker.bind({ operationId: "bind-a", adminId: "admin", bindingId: "ba", laneAddress: "p/a", workspaceId: "w", adapter: "codex", conversationId: "th-a" });
  broker.bind({ operationId: "bind-b", adminId: "admin", bindingId: "bb", laneAddress: "p/b", workspaceId: "w", adapter: "codex", conversationId: "th-b" });
  return broker;
}
