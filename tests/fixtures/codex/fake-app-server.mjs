import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { WebSocketServer } from "ws";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.146.1-fake\n");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "generate-json-schema") {
  const out = args[args.indexOf("--out") + 1];
  if (!out) process.exit(2);
  await mkdir(`${out}/v1`, { recursive: true }); await mkdir(`${out}/v2`, { recursive: true });
  const compatible = process.env.FAKE_CODEX_SCHEMA !== "incompatible";
  const methods = compatible ? ["initialize", "thread/start", "thread/resume", "thread/read", "turn/start", "turn/steer"] : ["initialize"];
  const decoy = process.env.FAKE_CODEX_SCHEMA === "decoy";
  const format = process.env.FAKE_CODEX_FORMAT === "pretty" ? 2 : undefined;
  const emit = (path, value) => writeFile(path, JSON.stringify(value, null, format));
  const requestBranch = (method) => ({ type: "object", required: ["id", "method", "params"], properties: { id: { type: ["string", "number"] }, method: { enum: [method] }, params: { type: "object" } } });
  await emit(`${out}/ClientRequest.json`, decoy ? { description: methods.join(" "), oneOf: [{ type: "string" }] } : { oneOf: methods.map(requestBranch) });
  await emit(`${out}/ServerRequest.json`, decoy ? { description: "item/tool/call", oneOf: [] } : { oneOf: compatible ? [requestBranch("item/tool/call")] : [] });
  await emit(`${out}/v1/InitializeParams.json`, { type: "object", required: ["clientInfo"], properties: { clientInfo: { type: "object" } } });
  await emit(`${out}/v1/InitializeResponse.json`, { type: "object", required: ["codexHome", "platformFamily", "platformOs", "userAgent"], properties: Object.fromEntries(["codexHome", "platformFamily", "platformOs", "userAgent"].map((name) => [name, { type: "string" }])) });
  const dynamicTools = process.env.FAKE_CODEX_SCHEMA !== "missing-dynamic-tools" ? { dynamicTools: { type: ["array", "null"], items: { oneOf: [{ type: "object", required: ["type", "name", "description", "inputSchema"], properties: { type: { enum: ["function"] }, name: { type: "string" }, description: { type: "string" }, inputSchema: {} } }] } } } : {};
  await emit(`${out}/v2/ThreadStartParams.json`, { type: "object", properties: dynamicTools });
  for (const [name, required] of Object.entries({ ThreadResumeParams: ["threadId"], ThreadReadParams: ["threadId"], TurnStartParams: ["input", "threadId"], TurnSteerParams: ["expectedTurnId", "input", "threadId"] }))
    await emit(`${out}/v2/${name}.json`, { type: "object", required, properties: Object.fromEntries(required.map((field) => [field, field === "input" ? { type: "array" } : { type: "string" }])) });
  const thread = { type: "object", required: ["id", "status", "turns"], properties: { id: { type: "string" }, status: { type: "object", required: ["type"], properties: { type: { enum: ["idle", "active", "notLoaded"] } } }, turns: { type: "array" } } };
  for (const name of ["ThreadStartResponse", "ThreadResumeResponse", "ThreadReadResponse"]) await emit(`${out}/v2/${name}.json`, { type: "object", required: ["thread"], properties: { thread } });
  const turn = { type: "object", required: ["id", "status", "items"], properties: { id: { type: "string" }, status: { type: "string" }, items: { type: "array" } } };
  await emit(`${out}/v2/TurnStartResponse.json`, { type: "object", required: ["turn"], properties: { turn } });
  await emit(`${out}/v2/TurnSteerResponse.json`, { type: "object", required: ["turnId"], properties: { turnId: { type: "string" } } });
  await emit(`${out}/DynamicToolCallParams.json`, { type: "object", required: ["arguments", "callId", "threadId", "tool", "turnId"], properties: { arguments: {}, callId: { type: "string" }, threadId: { type: "string" }, tool: { type: "string" }, turnId: { type: "string" } } });
  await emit(`${out}/DynamicToolCallResponse.json`, { type: "object", required: ["contentItems", "success"], properties: { contentItems: { type: "array" }, success: { type: "boolean" } } });
  for (const [name, required] of Object.entries({ ThreadStatusChangedNotification: ["threadId", "status"], TurnStartedNotification: ["threadId", "turn"], TurnCompletedNotification: ["threadId", "turn"], ItemStartedNotification: ["threadId", "turnId", "item"], ItemCompletedNotification: ["threadId", "turnId", "item"] })) await emit(`${out}/v2/${name}.json`, { type: "object", required, properties: Object.fromEntries(required.map((field) => [field, ["threadId", "turnId"].includes(field) ? { type: "string" } : { type: "object" }])) });
  process.exit(0);
}
if (args[0] === "app-server") {
  const listen = args[args.indexOf("--listen") + 1];
  const url = new URL(listen);
  const server = new WebSocketServer({ host: url.hostname, port: Number(url.port) });
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === "initialize") {
      socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fake", platformFamily: "windows", platformOs: "windows", codexHome: "tmp" } }));
      const marker = process.env.FAKE_CODEX_EXIT_ONCE_FILE;
      if (marker && !existsSync(marker)) void writeFile(marker, "exited").then(() => setTimeout(() => process.exit(17), 20));
    }
    else if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: {} }));
  }));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
} else process.exit(2);
