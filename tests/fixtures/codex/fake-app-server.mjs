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
  await writeFile(`${out}/ClientRequest.json`, JSON.stringify({ methods }));
  await writeFile(`${out}/ServerRequest.json`, JSON.stringify({ methods: compatible ? ["item/tool/call"] : [] }));
  await writeFile(`${out}/v1/InitializeParams.json`, JSON.stringify({ required: ["clientInfo"] }));
  await writeFile(`${out}/v1/InitializeResponse.json`, JSON.stringify({ required: ["codexHome", "platformFamily", "platformOs", "userAgent"] }));
  for (const [name, required] of Object.entries({ ThreadStartParams: [], ThreadResumeParams: ["threadId"], TurnStartParams: ["input", "threadId"], TurnSteerParams: ["expectedTurnId", "input", "threadId"] }))
    await writeFile(`${out}/v2/${name}.json`, JSON.stringify({ required, properties: name === "ThreadStartParams" && process.env.FAKE_CODEX_SCHEMA !== "missing-dynamic-tools" ? { dynamicTools: {} } : {} }));
  await writeFile(`${out}/DynamicToolCallParams.json`, JSON.stringify({ required: ["arguments", "callId", "threadId", "tool", "turnId"] }));
  await writeFile(`${out}/DynamicToolCallResponse.json`, JSON.stringify({ required: ["contentItems", "success"] }));
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
