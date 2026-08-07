import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_SCHEMA_FILES = 512;
const MAX_SCHEMA_BYTES = 16 * 1024 * 1024;
const MAX_SCHEMA_DEPTH = 16;
const REQUIRED_METHODS = ["initialize", "thread/start", "thread/resume", "thread/read", "turn/start", "turn/steer", "item/tool/call"] as const;
const REQUIRED_FILES: Readonly<Record<string, readonly string[]>> = {
  "v1/InitializeParams.json": ["clientInfo"], "v1/InitializeResponse.json": ["codexHome", "platformFamily", "platformOs", "userAgent"],
  "v2/ThreadResumeParams.json": ["threadId"], "v2/ThreadReadParams.json": ["threadId"], "v2/TurnStartParams.json": ["input", "threadId"],
  "v2/TurnSteerParams.json": ["expectedTurnId", "input", "threadId"], "DynamicToolCallParams.json": ["arguments", "callId", "threadId", "tool", "turnId"],
  "DynamicToolCallResponse.json": ["contentItems", "success"],
};

export interface CodexCommand { readonly executable: string; readonly prefixArgs?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
export interface CapabilityReport { readonly version: string; readonly fingerprint: string; readonly schemaFingerprint: string; readonly cached: boolean }
export class CodexCapabilityError extends Error { readonly code = "CODEX_CAPABILITY_INCOMPATIBLE"; constructor(message: string, readonly evidence?: unknown) { super(message); this.name = new.target.name; } }

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
      try { await execFileAsync(command.executable, [...(command.prefixArgs ?? []), "app-server", "generate-json-schema", "--experimental", "--out", schemaDir], { env, windowsHide: true, maxBuffer: MAX_SCHEMA_BYTES }); }
      catch (error) { throw new CodexCapabilityError("Codex experimental schema generation failed", error); }
      const schemaFingerprint = await validateSchema(schemaDir);
      const executableFingerprint = await commandFingerprint(command, env);
      const fingerprint = createHash("sha256").update(`${executableFingerprint}\0${version}\0${schemaFingerprint}`).digest("hex");
      const cached = await readCache(this.options.cacheDir, fingerprint);
      await writeCache(this.options.cacheDir, { fingerprint, version, schemaFingerprint });
      return { version, fingerprint, schemaFingerprint, cached };
    } finally { await rm(schemaDir, { recursive: true, force: true }); }
  }
}

async function commandFingerprint(command: CodexCommand, env: NodeJS.ProcessEnv): Promise<string> {
  const hash = createHash("sha256");
  const executable = await resolveExecutable(command.executable, env);
  for (const input of [executable, ...(command.prefixArgs ?? []).filter((arg) => !arg.startsWith("-"))]) {
    try {
      const path = await realpath(input);
      const info = await stat(path);
      hash.update(`${path}:${info.size}:`);
      for await (const chunk of createReadStream(path)) hash.update(chunk);
    } catch { hash.update(input); }
  }
  return hash.digest("hex");
}

async function resolveExecutable(executable: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (isAbsolute(executable) || executable.includes(sep) || executable.includes("/")) return realpath(executable);
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const candidates = process.platform === "win32" && /\.[^./\\]+$/.test(executable) ? [executable] : extensions.map((extension) => `${executable}${extension.toLowerCase()}`);
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) for (const candidate of candidates) {
    try { return await realpath(join(directory, candidate)); } catch { /* continue */ }
  }
  throw new CodexCapabilityError(`Unable to resolve executable from PATH: ${executable}`);
}

async function readCache(cacheDir: string, fingerprint: string): Promise<boolean> {
  await mkdir(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, "codex-capability.json");
  try {
    const info = await lstat(cachePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new CodexCapabilityError("Codex capability cache entry must be a regular file");
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && (parsed as Record<string, unknown>).fingerprint === fingerprint;
  } catch (error) {
    if (error instanceof CodexCapabilityError) throw error;
    if (error instanceof SyntaxError) return false;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CodexCapabilityError("Unable to read Codex capability cache", error);
    return false;
  }
}

async function writeCache(cacheDir: string, value: unknown): Promise<void> {
  const cachePath = join(cacheDir, "codex-capability.json");
  try {
    const existing = await lstat(cachePath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new CodexCapabilityError("Codex capability cache entry must be a regular file");
    const temporary = join(cacheDir, `.codex-capability-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { await rename(temporary, cachePath); } finally { await rm(temporary, { force: true }); }
  } catch (error) { if (error instanceof CodexCapabilityError) throw error; throw new CodexCapabilityError("Unable to atomically update Codex capability cache", error); }
}

async function validateSchema(root: string): Promise<string> {
  const files = await listFiles(root);
  const hash = createHash("sha256");
  const schemas = new Map<string, Record<string, unknown>>();
  for (const path of files.sort()) {
    const relative = path.slice(root.length + 1).replaceAll("\\", "/");
    const schema = record(JSON.parse(await readFile(path, "utf8")) as unknown);
    schemas.set(relative, schema); hash.update(relative).update("\0").update(JSON.stringify(canonicalSchema(schema)));
  }
  const clientRequests = requiredSchema(schemas, "ClientRequest.json");
  for (const method of REQUIRED_METHODS.filter((value) => value !== "item/tool/call")) assertMethodBranch(clientRequests, method);
  assertMethodBranch(requiredSchema(schemas, "ServerRequest.json"), "item/tool/call");
  for (const [relative, required] of Object.entries(REQUIRED_FILES)) assertObjectFields(requiredSchema(schemas, relative), required, relative);
  for (const [relative, fields] of Object.entries({ "v1/InitializeResponse.json": ["codexHome", "platformFamily", "platformOs", "userAgent"], "v2/ThreadResumeParams.json": ["threadId"], "v2/ThreadReadParams.json": ["threadId"], "v2/TurnStartParams.json": ["threadId"], "v2/TurnSteerParams.json": ["threadId", "expectedTurnId"], "DynamicToolCallParams.json": ["callId", "threadId", "tool", "turnId"] })) {
    const schema = requiredSchema(schemas, relative); for (const field of fields) assertType(propertySchema(schema, field, schema), schema, "string", `${relative}.${field}`);
  }
  for (const relative of ["v2/TurnStartParams.json", "v2/TurnSteerParams.json"]) { const schema = requiredSchema(schemas, relative); assertType(propertySchema(schema, "input", schema), schema, "array", `${relative}.input`); }
  const startSchema = requiredSchema(schemas, "v2/ThreadStartParams.json");
  if (!containsObjectVariant(propertySchema(startSchema, "dynamicTools", startSchema), startSchema, ["type", "name", "description", "inputSchema"], "type", "function")) throw new CodexCapabilityError("ThreadStartParams dynamicTools lacks the function tool discriminator/shape");
  for (const relative of ["v2/ThreadStartResponse.json", "v2/ThreadResumeResponse.json", "v2/ThreadReadResponse.json"]) {
    const response = requiredSchema(schemas, relative); assertObjectFields(response, ["thread"], relative);
    const thread = propertySchema(response, "thread", response); assertObjectFieldsAt(thread, response, ["id", "status", "turns"], `${relative}.thread`);
    assertType(propertySchema(thread, "id", response), response, "string", `${relative}.thread.id`);
    const turns = propertySchema(thread, "turns", response); assertType(turns, response, "array", `${relative}.thread.turns`); assertTurnShape(arrayItemSchema(turns, response, `${relative}.thread.turns`), response, `${relative}.thread.turns[]`);
    const status = propertySchema(thread, "status", response); for (const discriminator of ["idle", "active", "notLoaded"]) if (!containsObjectVariant(status, response, ["type"], "type", discriminator)) throw new CodexCapabilityError(`${relative}.thread.status lacks required ${discriminator} type variant`);
  }
  const turnStart = requiredSchema(schemas, "v2/TurnStartResponse.json"); assertObjectFields(turnStart, ["turn"], "v2/TurnStartResponse.json"); assertTurnShape(propertySchema(turnStart, "turn", turnStart), turnStart, "v2/TurnStartResponse.json.turn");
  const steer = requiredSchema(schemas, "v2/TurnSteerResponse.json"); assertType(propertySchema(steer, "turnId", steer), steer, "string", "v2/TurnSteerResponse.json.turnId");
  const dynamicResponse = requiredSchema(schemas, "DynamicToolCallResponse.json"); assertType(propertySchema(dynamicResponse, "success", dynamicResponse), dynamicResponse, "boolean", "DynamicToolCallResponse.json.success");
  const contentItems = propertySchema(dynamicResponse, "contentItems", dynamicResponse); assertType(contentItems, dynamicResponse, "array", "DynamicToolCallResponse.json.contentItems");
  if (!containsObjectVariant(arrayItemSchema(contentItems, dynamicResponse, "DynamicToolCallResponse.json.contentItems"), dynamicResponse, ["type", "text"], "type", "inputText")) throw new CodexCapabilityError("DynamicToolCallResponse contentItems lacks inputText output shape");
  for (const [relative, required] of Object.entries({ "v2/ThreadStatusChangedNotification.json": ["threadId", "status"], "v2/TurnStartedNotification.json": ["threadId", "turn"], "v2/TurnCompletedNotification.json": ["threadId", "turn"], "v2/ItemStartedNotification.json": ["threadId", "turnId", "item"], "v2/ItemCompletedNotification.json": ["threadId", "turnId", "item"] })) assertObjectFields(requiredSchema(schemas, relative), required, relative);
  return hash.digest("hex");
}

async function listFiles(root: string, depth = 0, state = { count: 0, bytes: 0 }): Promise<string[]> {
  if (depth > MAX_SCHEMA_DEPTH) throw new CodexCapabilityError("Codex schema directory exceeds maximum depth");
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name); const info = await lstat(path);
    if (info.isSymbolicLink()) throw new CodexCapabilityError("Codex schema directory contains a symbolic link");
    if (info.isDirectory()) result.push(...await listFiles(path, depth + 1, state));
    else if (info.isFile()) {
      state.count += 1; state.bytes += info.size;
      if (state.count > MAX_SCHEMA_FILES || state.bytes > MAX_SCHEMA_BYTES) throw new CodexCapabilityError("Codex schema directory exceeds traversal limits");
      result.push(path);
    }
  }
  return result;
}

function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function requiredSchema(schemas: ReadonlyMap<string, Record<string, unknown>>, relative: string): Record<string, unknown> { const schema = schemas.get(relative); if (!schema) throw new CodexCapabilityError(`Codex schema lacks ${relative}`); return schema; }
function assertMethodBranch(schema: Record<string, unknown>, method: string): void { const branches = Array.isArray(schema.oneOf) ? schema.oneOf : []; const branch = branches.map(record).find((candidate) => containsEnumValue(record(record(candidate.properties).method), schema, method)); if (!branch) throw new CodexCapabilityError(`Codex schema lacks structural request method ${method}`); assertObjectFields(branch, ["id", "method", "params"], `${method} request`); }
function assertObjectFields(schema: Record<string, unknown>, fields: readonly string[], label: string): void { assertObjectFieldsAt(schema, schema, fields, label); }
function assertObjectFieldsAt(schema: Record<string, unknown>, root: Record<string, unknown>, fields: readonly string[], label: string): void { const resolved = resolveLocal(schema, root); const required = Array.isArray(resolved.required) ? resolved.required : []; const properties = record(resolved.properties); const missing = fields.filter((field) => !required.includes(field) || !(field in properties)); if (missing.length) throw new CodexCapabilityError(`${label} lacks required structural fields: ${missing.join(", ")}`); }
function arrayItemSchema(schema: Record<string, unknown>, root: Record<string, unknown>, label: string): Record<string, unknown> { const resolved = resolveLocal(schema, root); const items = record(resolved.items); if (Object.keys(items).length === 0) throw new CodexCapabilityError(`${label} lacks item schema`); return resolveLocal(items, root); }
function assertTurnShape(schema: Record<string, unknown>, root: Record<string, unknown>, label: string): void { assertObjectFieldsAt(schema, root, ["id", "status", "items"], label); assertType(propertySchema(schema, "id", root), root, "string", `${label}.id`); const status = propertySchema(schema, "status", root); for (const discriminator of ["completed", "interrupted", "failed", "inProgress"]) if (!containsEnumValue(status, root, discriminator)) throw new CodexCapabilityError(`${label}.status lacks ${discriminator} discriminator`); assertType(propertySchema(schema, "items", root), root, "array", `${label}.items`); }
function propertySchema(schema: Record<string, unknown>, property: string, root: Record<string, unknown>): Record<string, unknown> { const resolved = resolveLocal(schema, root); const value = record(record(resolved.properties)[property]); if (Object.keys(value).length === 0) throw new CodexCapabilityError(`Schema lacks property ${property}`); return resolveLocal(value, root); }
function resolveLocal(schema: Record<string, unknown>, root: Record<string, unknown>): Record<string, unknown> { let current = schema; const seen = new Set<string>(); for (let depth = 0; typeof current.$ref === "string" && current.$ref.startsWith("#/"); depth += 1) { if (depth >= MAX_SCHEMA_DEPTH || seen.has(current.$ref)) throw new CodexCapabilityError("Codex schema contains an excessive or cyclic local reference"); seen.add(current.$ref); let value: unknown = root; for (const segment of current.$ref.slice(2).split("/")) value = record(value)[segment.replaceAll("~1", "/").replaceAll("~0", "~")]; current = record(value); } return current; }
function assertType(schema: Record<string, unknown>, root: Record<string, unknown>, type: string, label: string): void { if (!hasType(schema, root, type)) throw new CodexCapabilityError(`${label} is not ${type}`); }
function hasType(schema: Record<string, unknown>, root: Record<string, unknown>, type: string, depth = 0): boolean { if (depth > MAX_SCHEMA_DEPTH) throw new CodexCapabilityError("Codex schema type traversal exceeds maximum depth"); const resolved = resolveLocal(schema, root); const types = Array.isArray(resolved.type) ? resolved.type : [resolved.type]; return types.includes(type) || ["oneOf", "anyOf", "allOf"].some((key) => Array.isArray(resolved[key]) && (resolved[key] as unknown[]).some((child) => hasType(record(child), root, type, depth + 1))); }
function containsEnumValue(schema: Record<string, unknown>, root: Record<string, unknown>, value: string, depth = 0): boolean { if (depth > MAX_SCHEMA_DEPTH) throw new CodexCapabilityError("Codex schema enum traversal exceeds maximum depth"); const resolved = resolveLocal(schema, root); if (Array.isArray(resolved.enum) && resolved.enum.includes(value)) return true; return ["oneOf", "anyOf", "allOf"].some((key) => Array.isArray(resolved[key]) && (resolved[key] as unknown[]).some((child) => containsEnumValue(record(child), root, value, depth + 1))) || Object.values(record(resolved.properties)).some((child) => containsEnumValue(record(child), root, value, depth + 1)); }
function containsObjectVariant(schema: Record<string, unknown>, root: Record<string, unknown>, fields: readonly string[], discriminator: string, value: string, depth = 0): boolean { if (depth > MAX_SCHEMA_DEPTH) throw new CodexCapabilityError("Codex schema object traversal exceeds maximum depth"); const resolved = resolveLocal(schema, root); try { assertObjectFieldsAt(resolved, root, fields, "object variant"); if (containsEnumValue(propertySchema(resolved, discriminator, root), root, value)) return true; } catch (error) { if (error instanceof CodexCapabilityError && /exceeds|cyclic/.test(error.message)) throw error; } return ["oneOf", "anyOf", "allOf"].some((key) => Array.isArray(resolved[key]) && (resolved[key] as unknown[]).some((child) => containsObjectVariant(record(child), root, fields, discriminator, value, depth + 1))) || (resolved.items !== undefined && containsObjectVariant(record(resolved.items), root, fields, discriminator, value, depth + 1)); }
function canonicalSchema(value: unknown, parentKey = "", depth = 0): unknown { if (depth > MAX_SCHEMA_DEPTH * 4) throw new CodexCapabilityError("Codex schema canonicalization exceeds maximum depth"); if (Array.isArray(value)) { const items = value.map((item) => canonicalSchema(item, parentKey, depth + 1)); return ["required", "enum", "oneOf", "anyOf", "allOf"].includes(parentKey) ? items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) : items; } if (typeof value !== "object" || value === null) return value; const ignored = new Set(["$schema", "$id", "description", "title", "examples"]); return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !ignored.has(key)).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalSchema(child, key, depth + 1)])); }
