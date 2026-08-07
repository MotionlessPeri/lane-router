import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { BrokerService } from "../../../dist/broker/broker-service.js";
import { Scheduler } from "../../../dist/broker/scheduler.js";
import { BrokerClient } from "../../../dist/client/broker-client.js";
import { ClaudeAdapter } from "../../../dist/adapters/claude/claude-adapter.js";
import { startBrokerHttpServer } from "../../../dist/server/http-server.js";
import { openDatabase } from "../../../dist/storage/database.js";

const timeoutMs = Number(process.env.CLAUDE_CHANNEL_SMOKE_TIMEOUT_MS ?? 240_000);
const claudeExe = process.env.CLAUDE_EXE ?? "claude";
const sourceSettings = process.env.CLAUDE_SETTINGS_FILE;
if (!sourceSettings) fail("CLAUDE_SETTINGS_FILE is required");

const temporary = await mkdtemp(join(tmpdir(), "lane-router-claude-channel-"));
const database = openDatabase(join(temporary, "router.sqlite"));
let server;
let child;
let claudeDiagnostic = "none";
let startupOutput = "";
const startedAt = Date.now();
try {
  await copyFile(sourceSettings, join(temporary, "settings.json"));
  await writeFile(join(temporary, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: process.env.CLAUDE_VERSION ?? "fixture",
    projects: { [temporary]: { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true } },
  }), { mode: 0o600 });
  const service = new BrokerService(database);
  server = await startBrokerHttpServer({ service, token: "fixture-discovery", sessionSecret: "fixture-session-secret", port: 0 });
  const admin = new BrokerClient(server.url, "fixture-discovery");
  await admin.call("syncProject", {
    operationId: "fixture-sync", workspaceId: "fixture-workspace", rootPath: resolve("."),
    manifest: { projectId: "fixture", projectKey: "fixture", displayName: "Fixture", manifestHash: "fixture-hash", manifestVersion: 1, lanes: [
      { name: "sender", roleFile: "sender.md", communicationEntry: true },
      { name: "claude", roleFile: "claude.md", communicationEntry: true },
    ] },
  });
  const sender = await admin.call("bind", { operationId: "fixture-bind-sender", bindingId: "fixture-sender", laneAddress: "fixture/sender", workspaceId: "fixture-workspace", adapter: "codex", conversationId: "fixture-sender-conversation" });
  const target = await admin.call("bind", { operationId: "fixture-bind-claude", bindingId: "fixture-claude", laneAddress: "fixture/claude", workspaceId: "fixture-workspace", adapter: "claude", conversationId: "fixture-claude-conversation" });
  const configPath = join(temporary, "mcp.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: { lane: {
    type: "stdio", command: process.execPath, args: [resolve("dist/mcp/lane-mcp-server.js")],
    env: {
      LANE_ROUTER_URL: server.url,
      LANE_ROUTER_DISCOVERY_TOKEN: "unused-by-binding-client",
      LANE_ROUTER_BINDING_CREDENTIAL: target.bindingCredential,
      LANE_ROUTER_BINDING_ID: "fixture-claude",
      LANE_ROUTER_BINDING_GENERATION: "1",
    },
  } } }), { mode: 0o600 });
  const adapter = new ClaudeAdapter({
    resolveBinding: (laneId, generation) => laneId === "fixture/claude" && generation === 1 ? { bindingId: "fixture-claude" } : undefined,
    channels: server.claudeChannels,
  });
  const unavailable = { getRuntimeState: async () => ({ availability: "offline", turn: "unknown" }), deliver: async () => "stored_pending" };
  const scheduler = new Scheduler(database, { claude: adapter, codex: unavailable }, service.config);
  const senderClient = new BrokerClient(server.url, "unused", sender.bindingCredential);

  child = launchClaude(configPath, temporary);
  await waitFor(() => server.claudeChannels.getRuntimeState("fixture-claude", 1).availability === "online", 30_000, "first_channel_connect");
  const first = await senderClient.call("send", { operationId: "fixture-send-first", target: "fixture/claude", kind: "normal", body: "Disposable integration check: fetch this message, claim its delivery, then acknowledge it with outcome applied. Do not modify files or call non-Lane tools.", metadata: {} });
  await scheduler.runOnce();
  const firstState = readDelivery(first.deliveryId);
  if (firstState.adapterResult !== "started_new_turn") fail("idle wake did not start a new turn");
  const second = await senderClient.call("send", { operationId: "fixture-send-second", target: "fixture/claude", kind: "correction", body: "Disposable integration correction: fetch this message too, claim its delivery, then acknowledge it with outcome applied. Do not modify files or call non-Lane tools.", metadata: {} });
  await scheduler.runOnce();
  const secondState = readDelivery(second.deliveryId);
  if (secondState.adapterResult !== "queued_next_turn") fail("busy wake was not queued for the next turn");
  await waitFor(() => [first.deliveryId, second.deliveryId].every((id) => readDelivery(id).state === "acknowledged"), timeoutMs, "two_message_ack");

  await stopClaude(child); child = undefined;
  await waitFor(() => server.claudeChannels.getRuntimeState("fixture-claude", 1).availability === "offline", 10_000, "disconnect");
  const third = await senderClient.call("send", { operationId: "fixture-send-third", target: "fixture/claude", kind: "normal", body: "Disposable reconnect check: fetch this message, claim its delivery, then acknowledge it with outcome applied. Do not modify files or call non-Lane tools.", metadata: {} });
  const disconnectedResult = await adapter.deliver({ deliveryId: third.deliveryId, messageId: third.messageId, targetLaneId: "fixture/claude", sequence: third.sequence, kind: "normal", bindingGeneration: 1 });
  if (disconnectedResult !== "stored_pending") fail("disconnected wake was not stored pending");

  child = launchClaude(configPath, temporary);
  await waitFor(() => server.claudeChannels.getRuntimeState("fixture-claude", 1).availability === "online", 30_000, "reconnect");
  await scheduler.runOnce();
  await waitFor(() => readDelivery(third.deliveryId).state === "acknowledged", timeoutMs, "reconnected_message_ack");
  console.log(JSON.stringify({ stage: "complete", claudeVersion: process.env.CLAUDE_VERSION ?? "unknown", notificationResults: [firstState.adapterResult, secondState.adapterResult, disconnectedResult], acknowledgedCount: 3, reconnectObserved: true, tuiAttached: false, elapsedMs: Date.now() - startedAt }));

  function readDelivery(id) {
    return database.prepare("SELECT state,adapter_result AS adapterResult FROM delivery WHERE id=?").get(id);
  }
} catch (error) {
  console.error(JSON.stringify({ stage: "failed", reason: error instanceof Error ? error.message : "unknown", ...(process.env.CLAUDE_CHANNEL_SMOKE_DEBUG === "1" ? { startup: sanitizeStartup(startupOutput, temporary) } : {}) }));
  process.exitCode = 1;
} finally {
  if (child) await stopClaude(child);
  if (server) await server.close();
  database.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function launchClaude(configPath, configDirectory) {
  const allowed = ["lane_whoami", "lane_status", "lane_send", "lane_inbox_list", "lane_message_get", "lane_message_claim", "lane_message_ack", "lane_message_park"].map((tool) => `mcp__lane__${tool}`).join(",");
  const process = spawn("python", [resolve("tests/fixtures/claude/pty-host.py"), claudeExe, "--dangerously-load-development-channels", "server:lane", "--mcp-config", configPath, "--strict-mcp-config", "--permission-mode", "bypassPermissions", "--allowedTools", allowed], {
    cwd: configDirectory, env: { ...globalThis.process.env, CLAUDE_CONFIG_DIR: configDirectory, CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let capturedBytes = 0;
  for (const stream of [process.stdout, process.stderr]) stream.on("data", (chunk) => {
    capturedBytes += chunk.length;
    const text = chunk.toString().toLowerCase();
    startupOutput = (startupOutput + chunk.toString()).slice(-16_384);
    if (text.includes("unknown option")) claudeDiagnostic = "invalid_cli_option";
    else if (text.includes("authentication") || text.includes("unauthorized")) claudeDiagnostic = "authentication";
    else if (text.includes("channel") && text.includes("policy")) claudeDiagnostic = "channel_policy";
    else if (text.includes("mcp") && (text.includes("failed") || text.includes("error"))) claudeDiagnostic = "mcp_startup";
    else if (text.includes("api error") || text.includes("rate limit")) claudeDiagnostic = "provider_api";
    else if (text.includes("press enter") || text.includes("confirm") || text.includes("trust this")) claudeDiagnostic = "interactive_confirmation";
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
}

async function waitFor(predicate, limit, stage) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (child && (child.exitCode !== null || child.signalCode !== null)) fail(`Claude exited during ${stage} (${child.exitCode ?? child.signalCode}; ${claudeDiagnostic})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`Timed out during ${stage} (${claudeDiagnostic})`);
}

function fail(message) { throw new Error(message); }

function sanitizeStartup(value, temporaryPath) {
  return value.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replaceAll(temporaryPath, "<TEMP>").replace(/[A-Za-z0-9_-]{80,}/g, "<REDACTED>").slice(-2_000);
}
