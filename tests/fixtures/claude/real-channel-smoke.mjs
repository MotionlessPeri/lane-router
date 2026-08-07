import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { BrokerService } from "../../../dist/broker/broker-service.js";
import { Scheduler } from "../../../dist/broker/scheduler.js";
import { BrokerClient } from "../../../dist/client/broker-client.js";
import { ClaudeAdapter } from "../../../dist/adapters/claude/claude-adapter.js";
import { startBrokerHttpServer } from "../../../dist/server/http-server.js";
import { openDatabase } from "../../../dist/storage/database.js";

const execFile = promisify(execFileCallback);
const timeoutMs = Number(process.env.CLAUDE_CHANNEL_SMOKE_TIMEOUT_MS ?? 240_000);
const claudeExe = process.env.CLAUDE_EXE ?? "claude";
const repoRoot = resolve(".");
const cleanups = [];
let database;
let server;
let child;
let claudeDiagnostic = "none";
let outcome;
const startedAt = Date.now();
class FixtureError extends Error { constructor(code, phase) { super(code); this.code = code; this.phase = phase; } }

try {
  const sourceSettings = requiredEnvironment("CLAUDE_SETTINGS_FILE");
  const sourceState = requiredEnvironment("CLAUDE_APPROVAL_STATE_FILE");
  const approvedProject = requiredEnvironment("CLAUDE_APPROVED_PROJECT").replaceAll("\\", "/");
  const expectedRuntimeSha = requiredEnvironment("EXPECTED_RUNTIME_SHA");
  await access(approvedProject);
  const runtimeSha = (await execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
  if (runtimeSha !== expectedRuntimeSha) fail("runtime_sha_mismatch");

  const temporary = await mkdtemp(join(tmpdir(), "lane-router-claude-channel-"));
  cleanups.push(async () => rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const configDirectory = join(temporary, "claude-config");
  await mkdir(configDirectory);
  await writeIsolatedSettings(sourceSettings, join(configDirectory, "settings.json"));
  await writeMinimalApprovalState(sourceState, approvedProject, join(temporary, ".claude.json"));

  database = openDatabase(join(temporary, "router.sqlite"));
  cleanups.push(async () => { database?.close(); database = undefined; });
  const service = new BrokerService(database);
  server = await startBrokerHttpServer({ service, token: "fixture-discovery", sessionSecret: "fixture-session-secret", port: 0 });
  cleanups.push(async () => { await server?.close(); server = undefined; });
  cleanups.push(async () => { if (child) await stopClaude(child); child = undefined; });

  const admin = new BrokerClient(server.url, "fixture-discovery");
  await admin.call("syncProject", {
    operationId: "fixture-sync", workspaceId: "fixture-workspace", rootPath: repoRoot,
    manifest: { projectId: "fixture", projectKey: "fixture", displayName: "Fixture", manifestHash: "fixture-hash", manifestVersion: 1, lanes: [
      { name: "sender", roleFile: "sender.md", communicationEntry: true },
      { name: "claude", roleFile: "claude.md", communicationEntry: true },
    ] },
  });
  const sender = await admin.call("bind", { operationId: "fixture-bind-sender", bindingId: "fixture-sender", laneAddress: "fixture/sender", workspaceId: "fixture-workspace", adapter: "codex", conversationId: "fixture-sender-conversation" });
  const target = await admin.call("bind", { operationId: "fixture-bind-claude", bindingId: "fixture-claude", laneAddress: "fixture/claude", workspaceId: "fixture-workspace", adapter: "claude", conversationId: "fixture-claude-conversation" });
  const configPath = join(temporary, "mcp.json");
  const writeMcpConfig = (connectionEpoch) => writeFile(configPath, JSON.stringify({ mcpServers: { lane: {
    type: "stdio", command: process.execPath, args: [resolve(repoRoot, "dist/mcp/lane-mcp-server.js")],
    env: {
      LANE_ROUTER_URL: server.url,
      LANE_ROUTER_DISCOVERY_TOKEN: "unused-by-binding-client",
      LANE_ROUTER_BINDING_CREDENTIAL: target.bindingCredential,
      LANE_ROUTER_BINDING_ID: "fixture-claude",
      LANE_ROUTER_BINDING_GENERATION: "1",
      LANE_ROUTER_CLAUDE_CONNECTION_EPOCH: connectionEpoch,
    },
  } } }), { mode: 0o600 });
  const adapter = new ClaudeAdapter({
    resolveBinding: (laneId, generation) => laneId === "fixture/claude" && generation === 1 ? { bindingId: "fixture-claude" } : undefined,
    channels: server.claudeChannels,
  });
  const unavailable = { getRuntimeState: async () => ({ availability: "offline", turn: "unknown" }), deliver: async () => "stored_pending" };
  let scheduler = new Scheduler(database, { claude: adapter, codex: unavailable }, service.config);
  const senderClient = new BrokerClient(server.url, "unused", sender.bindingCredential);

  const firstEpoch = randomUUID();
  await writeMcpConfig(firstEpoch);
  child = launchClaude(configPath, configDirectory, approvedProject, firstEpoch, target.bindingCredential);
  await waitFor(() => server.claudeChannels.getRuntimeState("fixture-claude", 1).turn === "idle", 30_000, "first_channel_readiness");
  const first = await senderClient.call("send", { operationId: "fixture-send-first", target: "fixture/claude", kind: "normal", body: recordedInstruction("first"), metadata: {} });
  await scheduler.runOnce();
  const firstState = readDelivery(first.deliveryId);
  if (firstState.adapterResult !== "started_new_turn") fail("idle_wake_mismatch");
  const second = await senderClient.call("send", { operationId: "fixture-send-second", target: "fixture/claude", kind: "correction", body: recordedInstruction("correction"), metadata: {} });
  await scheduler.runOnce();
  const secondState = readDelivery(second.deliveryId);
  if (secondState.adapterResult !== "queued_next_turn") fail("busy_wake_mismatch");
  await waitFor(() => [first.deliveryId, second.deliveryId].every((id) => readDelivery(id).state === "acknowledged"), timeoutMs, "two_message_ack");
  assertRecordedAck(first.deliveryId); assertRecordedAck(second.deliveryId);

  await stopClaude(child); child = undefined;
  await waitFor(() => server.claudeChannels.getRuntimeState("fixture-claude", 1).availability === "offline", 10_000, "disconnect");
  const third = await senderClient.call("send", { operationId: "fixture-send-third", target: "fixture/claude", kind: "normal", body: recordedInstruction("reconnect"), metadata: {} });
  const disconnectedResult = await adapter.deliver({ deliveryId: third.deliveryId, messageId: third.messageId, targetLaneId: "fixture/claude", sequence: third.sequence, kind: "normal", bindingGeneration: 1 });
  if (disconnectedResult !== "stored_pending") fail("disconnect_result_mismatch");

  const secondEpoch = randomUUID();
  await writeMcpConfig(secondEpoch);
  child = launchClaude(configPath, configDirectory, approvedProject, secondEpoch, target.bindingCredential);
  await waitFor(() => server.claudeChannels.getRuntimeState("fixture-claude", 1).turn === "idle", 30_000, "reconnect_readiness");
  await scheduler.runOnce();
  await waitFor(() => readDelivery(third.deliveryId).state === "acknowledged", timeoutMs, "reconnected_message_ack");
  assertRecordedAck(third.deliveryId);
  outcome = { stage: "complete", claudeVersion: process.env.CLAUDE_VERSION ?? "unknown", runtimeSha, notificationResults: [firstState.adapterResult, secondState.adapterResult, disconnectedResult], acknowledgedCount: 3, reconnectObserved: true, tuiAttached: true, elapsedMs: Date.now() - startedAt };

  function readDelivery(id) { return database.prepare("SELECT state,adapter_result AS adapterResult FROM delivery WHERE id=?").get(id); }
  function assertRecordedAck(id) {
    const row = database.prepare("SELECT outcome_kind AS kind,outcome_payload_json AS payload FROM ack WHERE delivery_id=?").get(id);
    let payload;
    try { payload = JSON.parse(row?.payload ?? "null"); } catch { payload = null; }
    if (row?.kind !== "recorded" || typeof payload?.summary !== "string" || !payload.summary.trim()) fail("invalid_ack_outcome");
  }
} catch (error) {
  outcome = { stage: "failed", reason: error instanceof FixtureError ? error.code : "unexpected_fixture_failure", phase: error instanceof FixtureError ? error.phase : undefined, diagnostic: claudeDiagnostic };
} finally {
  const cleanupFailures = [];
  for (const cleanup of cleanups.reverse()) {
    const [result] = await Promise.allSettled([Promise.resolve().then(cleanup)]);
    if (result.status === "rejected") cleanupFailures.push("resource_cleanup_failed");
  }
  if (cleanupFailures.length) outcome = { stage: "failed", reason: "cleanup_failed", cleanupFailureCount: cleanupFailures.length, diagnostic: claudeDiagnostic };
  const failed = outcome?.stage !== "complete";
  (failed ? console.error : console.log)(JSON.stringify(outcome ?? { stage: "failed", reason: "missing_outcome", diagnostic: claudeDiagnostic }));
  if (failed) process.exitCode = 1;
}

async function writeIsolatedSettings(sourcePath, targetPath) {
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  const hookPath = resolve(repoRoot, "dist/adapters/claude/lifecycle-hook.js");
  const command = `"${process.execPath}" "${hookPath}"`;
  const selected = {};
  for (const key of ["env", "apiKeyHelper", "model", "alwaysThinkingEnabled"]) if (source[key] !== undefined) selected[key] = source[key];
  selected.hooks = Object.fromEntries(["UserPromptSubmit", "Stop"].map((event) => [event, [{ hooks: [{ type: "command", command, timeout: 5 }] }]]));
  await writeFile(targetPath, JSON.stringify(selected), { mode: 0o600 });
}

async function writeMinimalApprovalState(sourcePath, approvedProject, targetPath) {
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  const project = source.projects?.[approvedProject];
  if (!project || project.hasTrustDialogAccepted !== true) fail("approved_project_state_missing");
  const selected = {};
  for (const key of ["allowedTools", "enabledMcpjsonServers", "disabledMcpjsonServers", "hasTrustDialogAccepted", "projectOnboardingSeenCount", "hasClaudeMdExternalIncludesApproved", "hasClaudeMdExternalIncludesWarningShown"]) {
    const value = project[key];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) selected[key] = [...value];
    else if (typeof value === "boolean" || typeof value === "number") selected[key] = value;
  }
  await writeFile(targetPath, JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: source.lastOnboardingVersion, projects: { [approvedProject]: selected } }), { mode: 0o600 });
}

function launchClaude(configPath, configDirectory, approvedProject, connectionEpoch, credential) {
  const allowed = ["lane_whoami", "lane_status", "lane_send", "lane_inbox_list", "lane_message_get", "lane_message_claim", "lane_message_ack", "lane_message_park"].map((tool) => `mcp__lane__${tool}`).join(",");
  const process = spawn("python", [resolve(repoRoot, "tests/fixtures/claude/pty-host.py"), claudeExe, "--dangerously-load-development-channels", "server:lane", "--mcp-config", configPath, "--strict-mcp-config", "--permission-mode", "bypassPermissions", "--allowedTools", allowed], {
    cwd: approvedProject, env: { ...globalThis.process.env, CLAUDE_CONFIG_DIR: configDirectory, CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1", LANE_ROUTER_URL: server.url, LANE_ROUTER_BINDING_CREDENTIAL: credential, LANE_ROUTER_CLAUDE_CONNECTION_EPOCH: connectionEpoch }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let capturedBytes = 0;
  for (const stream of [process.stdout, process.stderr]) stream.on("data", (chunk) => {
    capturedBytes += chunk.length;
    const text = chunk.toString().toLowerCase();
    if (text.includes("unknown option")) claudeDiagnostic = "invalid_cli_option";
    else if (text.includes("authentication") || text.includes("unauthorized")) claudeDiagnostic = "authentication";
    else if (text.includes("channel") && text.includes("policy")) claudeDiagnostic = "channel_policy";
    else if (text.includes("mcp") && (text.includes("failed") || text.includes("error"))) claudeDiagnostic = "mcp_startup";
    else if (text.includes("api error") || text.includes("rate limit")) claudeDiagnostic = "provider_api";
    else if (text.includes("warning: loading development channels") || text.includes("i am using this for local development") || text.includes("press enter") || text.includes("confirm") || text.includes("trust this")) claudeDiagnostic = "interactive_confirmation";
    if (capturedBytes > 1_048_576) { claudeDiagnostic = "output_limit"; process.kill(); }
  });
  return process;
}

async function stopClaude(process) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.stdin.write("\x03\x03");
  await Promise.race([new Promise((resolve) => process.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (process.exitCode === null && process.signalCode === null) {
    process.kill();
    await Promise.race([new Promise((resolve) => process.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  if (process.exitCode === null && process.signalCode === null) fail("claude_stop_failed");
}

async function waitFor(predicate, limit, phase) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new FixtureError("claude_exited", phase);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new FixtureError("stage_timeout", phase);
}

function recordedInstruction(label) { return `Disposable ${label} check: fetch this message, claim its delivery, then acknowledge it with outcome {"kind":"recorded","summary":"lane-router disposable channel smoke recorded"}. Do not modify files or call non-Lane tools.`; }
function requiredEnvironment(name) { const value = process.env[name]; if (!value) throw new FixtureError("missing_environment", name); return value; }
function fail(code) { throw new FixtureError(code); }
