import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const executable = process.env.CODEX_EXE;
const sourceAuth = process.env.CODEX_AUTH_FILE;
if (!executable || !sourceAuth) throw new Error("CODEX_EXE and CODEX_AUTH_FILE are required");
const root = await mkdtemp(join(tmpdir(), "lane-router-real-codex-"));
const home = join(root, "codex-home"); const workspace = join(root, "workspace");
await mkdir(home); await mkdir(workspace); await copyFile(sourceAuth, join(home, "auth.json"));
const port = await freePort(); const endpoint = `ws://127.0.0.1:${port}`;
const child = spawn(executable, ["app-server", "--listen", endpoint], { env: { ...process.env, CODEX_HOME: home }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
let stderr = ""; child.stderr.on("data", (data) => { stderr = `${stderr}${data}`.slice(-4000); });
async function main() { try {
  const first = await Rpc.connect(endpoint);
  await first.initialize();
  const started = await first.request("thread/start", { cwd: workspace, approvalPolicy: "never", sandbox: "read-only", dynamicTools: [{ type: "function", name: "lane_whoami", description: "Return the current Lane Router identity.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
  const threadId = started.thread.id;
  let dynamicCall;
  first.onRequest = async (message) => {
    if (message.method !== "item/tool/call") throw new Error(`unexpected server request ${message.method}`);
    dynamicCall = message.params;
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ lane: "fixture-lane", bindingGeneration: 1 }) }] };
  };
  const turn = await first.request("turn/start", { threadId, input: [{ type: "text", text: "Call lane_whoami exactly once, then reply with a short acknowledgement." }] });
  await first.waitFor("turn/completed", (params) => params.threadId === threadId && params.turn.id === turn.turn.id, 300_000);
  if (!dynamicCall || dynamicCall.threadId !== threadId || dynamicCall.turnId !== turn.turn.id || !dynamicCall.callId) throw new Error("authoritative dynamic tool identifiers were not observed");
  await first.close();
  const second = await Rpc.connect(endpoint); await second.initialize();
  const resumed = await second.request("thread/resume", { threadId });
  if (resumed.thread.id !== threadId || !Array.isArray(resumed.thread.turns) || resumed.thread.turns.length < 1) throw new Error("resume did not include persisted history");
  console.log(JSON.stringify({ endpointHost: "127.0.0.1", threadId, turnId: turn.turn.id, callId: dynamicCall.callId, resumedTurnCount: resumed.thread.turns.length }));
  await second.close();
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}; app-server stderr tail: ${stderr}`);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(root, { recursive: true, force: true });
} }

class Rpc {
  static async connect(url) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) try { const rpc = new Rpc(url); await rpc.open(); return rpc; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error("app-server readiness timeout");
  }
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.notifications = []; }
  open() { return new Promise((resolve, reject) => { this.socket = new WebSocket(this.url); this.socket.once("open", resolve); this.socket.once("error", reject); this.socket.on("message", (data) => this.receive(JSON.parse(data.toString()))); }); }
  async initialize() { await this.request("initialize", { clientInfo: { name: "lane-router-real-fixture", version: "0.1.0" }, capabilities: { experimentalApi: true } }); this.socket.send(JSON.stringify({ method: "initialized" })); }
  request(method, params) { const id = this.nextId++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  receive(message) {
    if (message.id !== undefined && message.method) { void Promise.resolve(this.onRequest?.(message)).then((result) => this.socket.send(JSON.stringify({ id: message.id, result })), (error) => this.socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: error.message } }))); return; }
    if (message.id !== undefined) { const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); return; }
    this.notifications.push(message); this.notifyWaiters?.();
  }
  waitFor(method, predicate, timeoutMs) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs); const scan = () => { const found = this.notifications.find((item) => item.method === method && predicate(item.params)); if (!found) return; clearTimeout(timer); this.notifyWaiters = undefined; resolve(found.params); }; this.notifyWaiters = scan; scan(); }); }
  close() { return new Promise((resolve) => { this.socket.once("close", resolve); this.socket.close(); }); }
}
function freePort() { return new Promise((resolve, reject) => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close((error) => error ? reject(error) : resolve(port)); }); server.once("error", reject); }); }
await main();
