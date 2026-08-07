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
  "v2/ThreadReadParams.json": ["threadId"],
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
  const schemas = new Map<string, Record<string, unknown>>();
  for (const path of files.sort()) {
    const relative = path.slice(root.length + 1).replaceAll("\\", "/");
    const schema = record(JSON.parse(await readFile(path, "utf8")) as unknown);
    schemas.set(relative, schema);
    hash.update(relative).update("\0").update(JSON.stringify(canonicalSchema(schema)));
  }
  const clientRequests = requiredSchema(schemas, "ClientRequest.json");
  for (const method of REQUIRED_METHODS.filter((value) => value !== "item/tool/call")) assertMethodBranch(clientRequests, method);
  assertMethodBranch(requiredSchema(schemas, "ServerRequest.json"), "item/tool/call");
  for (const [relative, required] of Object.entries(REQUIRED_FILES)) {
    assertObjectFields(requiredSchema(schemas, relative), required, relative);
  }
  for (const [relative, fields] of Object.entries({ "v1/InitializeResponse.json": ["codexHome", "platformFamily", "platformOs", "userAgent"], "v2/ThreadResumeParams.json": ["threadId"], "v2/ThreadReadParams.json": ["threadId"], "v2/TurnStartParams.json": ["threadId"], "v2/TurnSteerParams.json": ["threadId", "expectedTurnId"], "DynamicToolCallParams.json": ["callId", "threadId", "tool", "turnId"] })) {
    const schema = requiredSchema(schemas, relative);
    for (const field of fields) assertType(propertySchema(schema, field, schema), schema, "string", `${relative}.${field}`);
  }
  for (const relative of ["v2/TurnStartParams.json", "v2/TurnSteerParams.json"]) { const schema = requiredSchema(schemas, relative); assertType(propertySchema(schema, "input", schema), schema, "array", `${relative}.input`); }
  const startSchema = requiredSchema(schemas, "v2/ThreadStartParams.json");
  const dynamicTools = propertySchema(startSchema, "dynamicTools", startSchema);
  if (!containsObjectVariant(dynamicTools, startSchema, ["type", "name", "description", "inputSchema"], "type", "function")) throw new CodexCapabilityError("ThreadStartParams dynamicTools lacks the function tool discriminator/shape");
  for (const relative of ["v2/ThreadStartResponse.json", "v2/ThreadResumeResponse.json", "v2/ThreadReadResponse.json"]) {
    const response = requiredSchema(schemas, relative);
    assertObjectFields(response, ["thread"], relative);
    const thread = propertySchema(response, "thread", response);
    assertObjectFields(thread, ["id", "status", "turns"], `${relative}.thread`);
    assertType(propertySchema(thread, "id", response), response, "string", `${relative}.thread.id`);
    assertType(propertySchema(thread, "turns", response), response, "array", `${relative}.thread.turns`);
    const status = propertySchema(thread, "status", response);
    for (const discriminator of ["idle", "active", "notLoaded"])
      if (!containsEnumValue(status, response, discriminator)) throw new CodexCapabilityError(`${relative}.thread.status lacks ${discriminator} discriminator`);
  }
  const turnStart = requiredSchema(schemas, "v2/TurnStartResponse.json");
  assertObjectFields(turnStart, ["turn"], "v2/TurnStartResponse.json");
  const turn = propertySchema(turnStart, "turn", turnStart);
  assertObjectFields(turn, ["id", "status", "items"], "v2/TurnStartResponse.json.turn");
  assertType(propertySchema(turn, "id", turnStart), turnStart, "string", "v2/TurnStartResponse.json.turn.id");
  const steer = requiredSchema(schemas, "v2/TurnSteerResponse.json");
  assertType(propertySchema(steer, "turnId", steer), steer, "string", "v2/TurnSteerResponse.json.turnId");
  for (const [relative, required] of Object.entries({ "v2/ThreadStatusChangedNotification.json": ["threadId", "status"], "v2/TurnStartedNotification.json": ["threadId", "turn"], "v2/TurnCompletedNotification.json": ["threadId", "turn"], "v2/ItemStartedNotification.json": ["threadId", "turnId", "item"], "v2/ItemCompletedNotification.json": ["threadId", "turnId", "item"] })) assertObjectFields(requiredSchema(schemas, relative), required, relative);
  return hash.digest("hex");
}
async function listFiles(root: string): Promise<string[]> { const result: string[] = []; for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) result.push(...await listFiles(path)); else result.push(path); } return result; }
function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function requiredSchema(schemas: ReadonlyMap<string, Record<string, unknown>>, relative: string): Record<string, unknown> { const schema = schemas.get(relative); if (!schema) throw new CodexCapabilityError(`Codex schema lacks ${relative}`); return schema; }
function assertMethodBranch(schema: Record<string, unknown>, method: string): void {
  const branches = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  const branch = branches.map(record).find((candidate) => containsEnumValue(record(record(candidate.properties).method), schema, method));
  if (!branch) throw new CodexCapabilityError(`Codex schema lacks structural request method ${method}`);
  assertObjectFields(branch, ["id", "method", "params"], `${method} request`);
}
function assertObjectFields(schema: Record<string, unknown>, fields: readonly string[], label: string): void {
  const resolved = resolveLocal(schema, schema);
  const required = Array.isArray(resolved.required) ? resolved.required : [];
  const properties = record(resolved.properties);
  const missing = fields.filter((field) => !required.includes(field) || !(field in properties));
  if (missing.length) throw new CodexCapabilityError(`${label} lacks required structural fields: ${missing.join(", ")}`);
}
function propertySchema(schema: Record<string, unknown>, property: string, root: Record<string, unknown>): Record<string, unknown> {
  const resolved = resolveLocal(schema, root);
  const value = record(record(resolved.properties)[property]);
  if (Object.keys(value).length === 0) throw new CodexCapabilityError(`Schema lacks property ${property}`);
  return resolveLocal(value, root);
}
function resolveLocal(schema: Record<string, unknown>, root: Record<string, unknown>): Record<string, unknown> {
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) return schema;
  let value: unknown = root;
  for (const segment of schema.$ref.slice(2).split("/")) value = record(value)[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  return record(value);
}
function assertType(schema: Record<string, unknown>, root: Record<string, unknown>, type: string, label: string): void {
  if (!hasType(schema, root, type)) throw new CodexCapabilityError(`${label} is not ${type}`);
}
function hasType(schema: Record<string, unknown>, root: Record<string, unknown>, type: string): boolean { const resolved = resolveLocal(schema, root); const types = Array.isArray(resolved.type) ? resolved.type : [resolved.type]; return types.includes(type) || ["oneOf", "anyOf", "allOf"].some((key) => Array.isArray(resolved[key]) && (resolved[key] as unknown[]).some((child) => hasType(record(child), root, type))); }
function containsEnumValue(schema: Record<string, unknown>, root: Record<string, unknown>, value: string): boolean {
  const resolved = resolveLocal(schema, root);
  if (Array.isArray(resolved.enum) && resolved.enum.includes(value)) return true;
  return ["oneOf", "anyOf", "allOf"].some((key) => Array.isArray(resolved[key]) && (resolved[key] as unknown[]).some((child) => containsEnumValue(record(child), root, value))) || Object.values(record(resolved.properties)).some((child) => containsEnumValue(record(child), root, value));
}
function containsObjectVariant(schema: Record<string, unknown>, root: Record<string, unknown>, fields: readonly string[], discriminator: string, value: string): boolean {
  const resolved = resolveLocal(schema, root);
  try { assertObjectFields(resolved, fields, "dynamic tool function"); if (containsEnumValue(propertySchema(resolved, discriminator, root), root, value)) return true; } catch { /* inspect nested variants */ }
  return ["oneOf", "anyOf", "allOf"].some((key) => Array.isArray(resolved[key]) && (resolved[key] as unknown[]).some((child) => containsObjectVariant(record(child), root, fields, discriminator, value))) || (resolved.items !== undefined && containsObjectVariant(record(resolved.items), root, fields, discriminator, value));
}
function canonicalSchema(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalSchema(item, parentKey));
    return ["required", "enum", "oneOf", "anyOf", "allOf"].includes(parentKey) ? items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) : items;
  }
  if (typeof value !== "object" || value === null) return value;
  const ignored = new Set(["$schema", "$id", "description", "title", "examples"]);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !ignored.has(key)).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalSchema(child, key)]));
}

export class CodexAppServerProcess {
  private child?: ChildProcess;
  private started = false;
  private lifecycleEpoch = 0;
  private restartAbort?: AbortController;
  private restartTask?: Promise<void>;
  private endpoint?: string;
  private readonly reconnectHandlers = new Set<() => void>();
  private readonly _client: AppServerClient;
  get client(): AppServerClient { return this._client; }
  constructor(private readonly options: { command: CodexCommand; gate: CodexCapabilityGate; readinessTimeoutMs?: number; restartLimit?: number; restartBackoffMs?: number; spawnProcess?: typeof spawn; onReconnect?: () => void }) {
    this._client = new AppServerClient({ url: "ws://127.0.0.1:0", requestTimeoutMs: options.readinessTimeoutMs ?? 5_000 });
  }
  onReconnect(handler: () => void): () => void { this.reconnectHandlers.add(handler); return () => this.reconnectHandlers.delete(handler); }
  async start(): Promise<string> {
    const epoch = ++this.lifecycleEpoch;
    this.started = true;
    try {
      await this.options.gate.verify(this.options.command);
      this.assertActive(epoch);
      return await this.spawnManaged(epoch);
    } catch (error) {
      if (this.lifecycleEpoch === epoch) {
        this.started = false;
        this.lifecycleEpoch += 1;
        await this.stopChildAndClient();
      }
      throw error;
    }
  }
  private async spawnManaged(epoch: number): Promise<string> {
    const port = await selectLoopbackPort();
    this.assertActive(epoch);
    const endpoint = `ws://127.0.0.1:${port}`;
    const command = this.options.command;
    const spawnProcess = this.options.spawnProcess ?? spawn;
    this.assertActive(epoch);
    const child = spawnProcess(command.executable, [...(command.prefixArgs ?? []), "app-server", "--listen", endpoint], { env: { ...process.env, ...command.env }, stdio: "ignore", windowsHide: true });
    this.child = child; this.endpoint = endpoint;
    let ready = false;
    child.once("exit", () => {
      if (this.child === child) this.child = undefined;
      if (ready && this.isActive(epoch)) this.scheduleRestart(epoch);
    });
    this._client.setUrl(endpoint);
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 5_000);
    let lastError: unknown;
    try {
      while (Date.now() < deadline) {
        this.assertActive(epoch);
        if (child.exitCode !== null) throw new Error(`Codex App Server exited before readiness (${child.exitCode})`);
        try {
          await this._client.connect();
          this.assertActive(epoch);
          if (child.exitCode !== null) throw new Error(`Codex App Server exited before readiness (${child.exitCode})`);
          ready = true;
          return endpoint;
        } catch (error) {
          lastError = error;
          await delay(20);
          this.assertActive(epoch);
        }
      }
      throw new Error(`Codex App Server readiness timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    } catch (error) {
      if (this.child === child) this.child = undefined;
      await this._client.close().catch(() => undefined);
      await terminateChild(child);
      throw error;
    }
  }
  private scheduleRestart(epoch: number): void {
    if (this.restartTask || !this.isActive(epoch)) return;
    const abort = new AbortController();
    this.restartAbort = abort;
    const task = this.restartLoop(epoch, abort.signal);
    let tracked: Promise<void>;
    tracked = task.finally(() => {
      if (this.restartTask === tracked) this.restartTask = undefined;
      if (this.restartAbort === abort) this.restartAbort = undefined;
    });
    this.restartTask = tracked;
  }
  private async restartLoop(epoch: number, signal: AbortSignal): Promise<void> {
    await this._client.close().catch(() => undefined);
    if (!this.isActive(epoch) || signal.aborted) return;
    for (let attempt = 0; attempt < (this.options.restartLimit ?? 3); attempt += 1) {
      await abortableDelay((this.options.restartBackoffMs ?? 100) * 2 ** attempt, signal);
      if (!this.isActive(epoch) || signal.aborted) return;
      try {
        await this.spawnManaged(epoch);
        if (!this.isActive(epoch) || signal.aborted) return;
        this.options.onReconnect?.();
        for (const handler of this.reconnectHandlers) handler();
        return;
      } catch (error) {
        if (!this.isActive(epoch) || signal.aborted) return;
      }
    }
  }
  async shutdown(): Promise<void> {
    this.started = false;
    this.lifecycleEpoch += 1;
    this.restartAbort?.abort();
    await this.stopChildAndClient();
    await this.restartTask?.catch(() => undefined);
    await this.stopChildAndClient();
  }
  private async stopChildAndClient(): Promise<void> {
    await this._client.close().catch(() => undefined);
    const child = this.child;
    this.child = undefined;
    if (child) await terminateChild(child);
  }
  private isActive(epoch: number): boolean { return this.started && this.lifecycleEpoch === epoch; }
  private assertActive(epoch: number): void {
    if (!this.isActive(epoch)) throw new CodexLifecycleCancelledError();
  }
}

class CodexLifecycleCancelledError extends Error { constructor() { super("Codex App Server lifecycle was cancelled"); this.name = new.target.name; } }

async function selectLoopbackPort(): Promise<number> { return new Promise((resolvePort, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (typeof address === "string" || address === null) return reject(new Error("Unable to select loopback port")); const port = address.port; server.close((error) => error ? reject(error) : resolvePort(port)); }); }); }
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolveDelay) => { if (signal.aborted) return resolveDelay(); const timer = setTimeout(resolveDelay, ms); timer.unref?.(); signal.addEventListener("abort", () => { clearTimeout(timer); resolveDelay(); }, { once: true }); }); }
async function terminateChild(child: ChildProcess): Promise<void> { if (child.exitCode !== null) return; await new Promise<void>((resolveDone) => { const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1_000); force.unref(); child.once("exit", () => { clearTimeout(force); resolveDone(); }); child.kill(); }); }
