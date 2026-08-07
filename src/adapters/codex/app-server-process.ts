import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { AppServerClient } from "./app-server-client.js";

const execFileAsync = promisify(execFile);
export interface CodexCommand { readonly executable: string; readonly prefixArgs?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
export interface CapabilityReport { readonly version: string; readonly fingerprint: string; readonly schemaFingerprint: string; readonly cached: boolean }
export class CodexCapabilityError extends Error { readonly code = "CODEX_CAPABILITY_INCOMPATIBLE"; constructor(message: string, readonly evidence?: unknown) { super(message); this.name = new.target.name; } }

const REQUIRED_METHODS = ["initialize", "thread/start", "thread/resume", "thread/read", "turn/start", "turn/steer", "item/tool/call"] as const;
const REQUIRED_FILES: Readonly<Record<string, readonly string[]>> = {
  "v1/InitializeParams.json": ["clientInfo"],
  "v1/InitializeResponse.json": ["codexHome", "platformFamily", "platformOs", "userAgent"],
  "v2/ThreadResumeParams.json": ["threadId"],
  "v2/TurnStartParams.json": ["input", "threadId"],
  "v2/TurnSteerParams.json": ["expectedTurnId", "input", "threadId"],
  "DynamicToolCallParams.json": ["arguments", "callId", "threadId", "tool", "turnId"],
  "DynamicToolCallResponse.json": ["contentItems", "success"],
};

export class CodexCapabilityGate {
  constructor(private readonly options: { cacheDir: string }) {}
  async verify(command: CodexCommand): Promise<CapabilityReport> {
    const env = { ...process.env, ...command.env };
    let version: string;
    try {
      const result = await execFileAsync(command.executable, [...(command.prefixArgs ?? []), "--version"], { env, windowsHide: true });
      version = result.stdout.trim();
      if (!/^codex-cli\s+\S+/.test(version)) throw new Error(`unexpected version output: ${version}`);
    } catch (error) { throw new CodexCapabilityError("Unable to fingerprint Codex executable/version", error); }
    const schemaDir = await mkdtemp(join(tmpdir(), "lane-router-codex-schema-"));
    try {
      try {
        await execFileAsync(command.executable, [...(command.prefixArgs ?? []), "app-server", "generate-json-schema", "--experimental", "--out", schemaDir], { env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      } catch (error) { throw new CodexCapabilityError("Codex experimental schema generation failed", error); }
      const schemaFingerprint = await validateSchema(schemaDir);
      const executableFingerprint = await commandFingerprint(command);
      const fingerprint = createHash("sha256").update(`${executableFingerprint}\0${version}\0${schemaFingerprint}`).digest("hex");
      await mkdir(this.options.cacheDir, { recursive: true });
      const cachePath = join(this.options.cacheDir, "codex-capability.json");
      let cached = false;
      try { cached = JSON.parse(await readFile(cachePath, "utf8")).fingerprint === fingerprint; } catch { /* first probe */ }
      await writeFile(cachePath, JSON.stringify({ fingerprint, version, schemaFingerprint }), { encoding: "utf8", mode: 0o600 });
      return { version, fingerprint, schemaFingerprint, cached };
    } finally { await rm(schemaDir, { recursive: true, force: true }); }
  }
}

async function commandFingerprint(command: CodexCommand): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [command.executable, ...(command.prefixArgs ?? []).filter((arg) => !arg.startsWith("-"))]) {
    try {
      const info = await stat(path);
      hash.update(`${resolve(path)}:${info.size}:`);
      for await (const chunk of createReadStream(path)) hash.update(chunk);
    } catch { hash.update(path); }
  }
  return hash.digest("hex");
}

async function validateSchema(root: string): Promise<string> {
  const files = await listFiles(root);
  const hash = createHash("sha256");
  let corpus = "";
  for (const path of files.sort()) { const contents = await readFile(path, "utf8"); hash.update(path.slice(root.length)).update("\0").update(contents); corpus += contents; }
  const missingMethods = REQUIRED_METHODS.filter((method) => !corpus.includes(`\"${method}\"`));
  if (missingMethods.length) throw new CodexCapabilityError(`Codex schema lacks required methods: ${missingMethods.join(", ")}`);
  for (const [relative, required] of Object.entries(REQUIRED_FILES)) {
    let schema: unknown;
    try { schema = JSON.parse(await readFile(join(root, ...relative.split("/")), "utf8")) as unknown; } catch (error) { throw new CodexCapabilityError(`Codex schema lacks ${relative}`, error); }
    const actual = record(schema).required;
    if (!Array.isArray(actual) || required.some((field) => !actual.includes(field))) throw new CodexCapabilityError(`${relative} lacks required fields: ${required.filter((field) => !Array.isArray(actual) || !actual.includes(field)).join(", ")}`);
  }
  const startSchema = record(JSON.parse(await readFile(join(root, "v2", "ThreadStartParams.json"), "utf8")) as unknown);
  if (!("dynamicTools" in record(startSchema.properties))) throw new CodexCapabilityError("ThreadStartParams.json lacks dynamicTools");
  return hash.digest("hex");
}
async function listFiles(root: string): Promise<string[]> { const result: string[] = []; for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) result.push(...await listFiles(path)); else result.push(path); } return result; }
function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export class CodexAppServerProcess {
  private child?: ChildProcess;
  private shuttingDown = false;
  private endpoint?: string;
  private _client?: AppServerClient;
  get client(): AppServerClient { if (!this._client) throw new Error("Codex App Server is not started"); return this._client; }
  constructor(private readonly options: { command: CodexCommand; gate: CodexCapabilityGate; readinessTimeoutMs?: number; restartLimit?: number; restartBackoffMs?: number; spawnProcess?: typeof spawn; onReconnect?: () => void }) {}
  async start(): Promise<string> {
    await this.options.gate.verify(this.options.command);
    this.shuttingDown = false;
    return this.spawnManaged();
  }
  private async spawnManaged(): Promise<string> {
    const port = await selectLoopbackPort();
    const endpoint = `ws://127.0.0.1:${port}`;
    const command = this.options.command;
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(command.executable, [...(command.prefixArgs ?? []), "app-server", "--listen", endpoint], { env: { ...process.env, ...command.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child; this.endpoint = endpoint;
    child.once("exit", () => { if (!this.shuttingDown && this.child === child) void this.restart(0); });
    const client = new AppServerClient({ url: endpoint, requestTimeoutMs: this.options.readinessTimeoutMs ?? 5_000 });
    this._client = client;
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 5_000);
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Codex App Server exited before readiness (${child.exitCode})`);
      try { await client.connect(); return endpoint; } catch (error) { lastError = error; await delay(20); }
    }
    child.kill(); throw new Error(`Codex App Server readiness timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  private async restart(attempt: number): Promise<void> {
    if (this.shuttingDown || attempt >= (this.options.restartLimit ?? 3)) return;
    await this._client?.close().catch(() => undefined);
    await delay((this.options.restartBackoffMs ?? 100) * 2 ** attempt);
    try { await this.spawnManaged(); this.options.onReconnect?.(); } catch { if (!this.shuttingDown) await this.restart(attempt + 1); }
  }
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this._client?.close().catch(() => undefined);
    const child = this.child; this.child = undefined;
    if (child && child.exitCode === null) await new Promise<void>((resolveDone) => { child.once("exit", () => resolveDone()); child.kill(); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1_000).unref(); });
  }
}

async function selectLoopbackPort(): Promise<number> { return new Promise((resolvePort, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (typeof address === "string" || address === null) return reject(new Error("Unable to select loopback port")); const port = address.port; server.close((error) => error ? reject(error) : resolvePort(port)); }); }); }
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
