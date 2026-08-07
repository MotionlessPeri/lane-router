import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexRuntime } from "../../../dist/adapters/codex/codex-runtime.js";
import { BrokerService } from "../../../dist/broker/broker-service.js";
import { Scheduler } from "../../../dist/broker/scheduler.js";
import { openDatabase } from "../../../dist/storage/database.js";

const executable = process.env.CODEX_EXE;
const sourceAuth = process.env.CODEX_AUTH_FILE;
const version = process.env.CODEX_VERSION ?? "unknown";
if (!executable || !sourceAuth) {
  console.error(JSON.stringify({ stage: "setup", code: "MISSING_REQUIRED_ENV" }));
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), "lane-router-real-codex-"));
const home = join(root, "codex-home");
const workspace = join(root, "workspace");
await mkdir(home); await mkdir(workspace);
await copyFile(sourceAuth, join(home, "auth.json"));
const database = openDatabase(join(root, "router.db"));
let runtime;
let resumedRuntime;
let stage = "broker_setup";
let threadId;
let turnId;
const toolNames = [];
const callIds = [];

try {
  const broker = createBroker(database, workspace);
  runtime = createCodexRuntime({ broker, command: { executable, env: { CODEX_HOME: home } }, capabilityCacheDir: join(root, "capability-cache"), adminId: "fixture-runtime" });
  stage = "runtime_start";
  await runtime.start();
  if (runtime.dynamicTools.length !== 8) throw coded("DYNAMIC_TOOL_COUNT");

  stage = "thread_start";
  threadId = await runtime.adapter.startThread({
    cwd: workspace,
    developerInstructions: "For each JSON wake envelope, call lane_message_get for every messageIds entry. Follow the retrieved message and use the requested lane tools before replying.",
  });
  const bound = broker.bind({ operationId: "bind-b", adminId: "fixture-admin", bindingId: "fixture-binding-b", laneAddress: "fixture/b", workspaceId: "fixture-workspace", adapter: "codex", conversationId: threadId });
  runtime.registerBinding({ laneId: "fixture/b", bindingId: bound.binding.id, generation: bound.binding.generation, threadId });

  let complete;
  const completed = new Promise((resolve) => { complete = resolve; });
  runtime.client.onNotification((notification) => {
    if (notification.method === "item/started") {
      const item = notification.params.item;
      if (typeof item === "object" && item !== null && item.type === "dynamicToolCall") {
        if (typeof item.tool === "string") toolNames.push(item.tool);
        if (typeof item.id === "string") callIds.push(item.id);
      }
    }
    if (notification.method === "turn/completed" && notification.params.threadId === threadId) {
      const turn = notification.params.turn;
      if (typeof turn === "object" && turn !== null && typeof turn.id === "string") turnId = turn.id;
      complete();
    }
  });

  stage = "broker_offline_turn";
  broker.send({
    operationId: "fixture-instruction",
    actor: { bindingId: "fixture-binding-a", generation: 1 },
    target: "fixture/b",
    kind: "normal",
    body: "Call lane_whoami. Then call lane_send exactly once with target fixture/a, kind normal, body fixture-result, empty metadata, and any nonempty operation_id. Then reply briefly.",
    metadata: {},
  });
  const scheduler = new Scheduler(database, { codex: runtime.adapter, claude: runtime.adapter }, broker.config);
  await scheduler.runOnce();
  await withTimeout(completed, 300_000, "TURN_TIMEOUT");

  stage = "verify_tool_effect";
  for (const expected of ["lane_message_get", "lane_whoami", "lane_send"])
    if (!toolNames.includes(expected)) throw coded("EXPECTED_TOOL_NOT_CALLED");
  const inbox = broker.inbox({ bindingId: "fixture-binding-a", generation: 1 });
  if (inbox.length !== 1) throw coded("TOOL_EFFECT_COUNT");
  const effect = broker.message({ bindingId: "fixture-binding-a", generation: 1 }, inbox[0].messageId);
  if (effect.body !== "fixture-result") throw coded("TOOL_EFFECT_RESULT");

  stage = "detach";
  await runtime.stop(); runtime = undefined;
  resumedRuntime = createCodexRuntime({ broker, command: { executable, env: { CODEX_HOME: home } }, capabilityCacheDir: join(root, "capability-cache"), adminId: "fixture-runtime-resumed" });
  stage = "resume_runtime";
  await resumedRuntime.start();
  await resumedRuntime.resumeBindingThread({ laneId: "fixture/b", bindingId: "fixture-binding-b", generation: 1, threadId });
  const history = await resumedRuntime.client.request("thread/read", { threadId, includeTurns: true });
  const turnCount = history && typeof history === "object" && history.thread && typeof history.thread === "object" && Array.isArray(history.thread.turns) ? history.thread.turns.length : 0;
  if (turnCount < 1) throw coded("RESUME_HISTORY_EMPTY");

  console.log(JSON.stringify({ stage: "complete", version, runtimeCommit: "0569261f947c5cfeff4471c88c60353f21e33e66", threadId, turnId, callIds, toolCount: toolNames.length, effectCount: inbox.length, resumedTurnCount: turnCount, tuiAttached: false }));
} catch (error) {
  console.error(JSON.stringify({ stage, code: error && typeof error === "object" && typeof error.code === "string" ? error.code : "REAL_FIXTURE_FAILED", toolCount: toolNames.length, callCount: callIds.length, threadId: threadId ?? null, turnId: turnId ?? null }));
  process.exitCode = 1;
} finally {
  await resumedRuntime?.stop().catch(() => undefined);
  await runtime?.stop().catch(() => undefined);
  database.close();
  await rm(root, { recursive: true, force: true });
}

function createBroker(database, workspace) {
  const broker = new BrokerService(database);
  broker.syncProject({ operationId: "sync", adminId: "fixture-admin", workspaceId: "fixture-workspace", rootPath: workspace, manifest: { projectId: "fixture", projectKey: "fixture", displayName: "Fixture", manifestHash: "fixture-hash", manifestVersion: 1, lanes: [{ name: "a", roleFile: "a.md", communicationEntry: true }, { name: "b", roleFile: "b.md", communicationEntry: false }] } });
  broker.bind({ operationId: "bind-a", adminId: "fixture-admin", bindingId: "fixture-binding-a", laneAddress: "fixture/a", workspaceId: "fixture-workspace", adapter: "codex", conversationId: "fixture-sender" });
  return broker;
}
function coded(code) { const error = new Error(code); error.code = code; return error; }
function withTimeout(promise, timeoutMs, code) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(coded(code)), timeoutMs); promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); }); }); }
