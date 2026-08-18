import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCodexRuntime } from "../adapters/codex/codex-runtime.js";
import { ClaudeBackend } from "../backends/claude-backend.js";
import { BackendRegistry } from "../router/backend.js";
import { openRouterDatabase } from "../router/database.js";
import { MailboxStore } from "../router/mailbox-store.js";
import { NotificationPump } from "../router/notification-pump.js";
import { RouterCore } from "../router/router-core.js";
import { RouterStateStore } from "../router/state-store.js";
import { ClaudeSessionLocator } from "./claude-session-locator.js";
import { ConversationRestorer } from "./conversation-restorer.js";
import { ToolService } from "../tools/tool-service.js";
import { ClaudeChannelHub, LocalRouterServer } from "./local-server.js";
import { RuntimeLock } from "./runtime-lock.js";

export async function runRouterProcess(options: { dataRoot?: string } = {}): Promise<{ close(): Promise<void> }> {
  const dataRoot = options.dataRoot ?? process.env.LANE_ROUTER_DATA_ROOT ?? join(homedir(), ".lane-router");
  mkdirSync(dataRoot, { recursive: true });
  const lock = RuntimeLock.acquire(join(dataRoot, "router.lock"));
  if (!lock) throw new Error("Another Router process is already running");
  const database = openRouterDatabase(join(dataRoot, "router.sqlite"));
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(dataRoot);
  const claudeHub = new ClaudeChannelHub((conversationId) => state.activeBindingForConversation("claude", conversationId));
  const claudeBackend = new ClaudeBackend(claudeHub);
  let tools: ToolService | undefined;
  const codex = createCodexRuntime({
    state,
    callTool: (name, args, context) => {
      if (!tools) throw new Error("Router tools are not ready");
      return tools.call(name, args, context);
    },
    command: { executable: process.env.CODEX_EXE ?? "codex" },
    capabilityCacheDir: join(dataRoot, "cache"),
  });
  let server: LocalRouterServer | undefined;
  const discoveryPath = join(dataRoot, "discovery.json");
  let closed = false;
  try {
    await codex.start();
    const backends = new BackendRegistry([claudeBackend, codex.backend]);
    const pump = new NotificationPump(state, mailbox, backends);
    const restore = new ConversationRestorer({
      state, backends,
      claudeSessions: new ClaudeSessionLocator(join(homedir(), ".claude", "projects")),
      fallbackCwd: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    });
    const core = new RouterCore({ state, mailbox, backends, pump, restore, newId: () => randomUUID(), now: Date.now });
    tools = new ToolService(core);
    server = new LocalRouterServer({
      tools, codex, claude: claudeHub, instanceId: randomUUID(),
      recordCwd: (conversationId, cwd) => state.updateBindingCwd("claude", conversationId, cwd),
      resumeInfo: (address) => core.resumeInfo(address),
    });
    mailbox.reconcile(state);
    const discovery = await server.start();
    writeDiscovery(discoveryPath, discovery);
    for (const backend of [claudeBackend, codex.backend]) backend.onAttentionOpportunity((lane) => { void pump.onAttentionOpportunity(lane); });
    await pump.onStartup();
  } catch (error) {
    await codex.stop().catch(() => undefined);
    database.close(); lock.release(); throw error;
  }

  return { close: async () => {
    if (closed) return; closed = true;
    rmSync(discoveryPath, { force: true });
    await server?.close();
    await codex.stop();
    database.close();
    lock.release();
  } };
}

function writeDiscovery(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  renameSync(temporary, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRouterProcess().then((runtime) => {
    const close = () => { void runtime.close().finally(() => { process.exitCode = 0; }); };
    process.once("SIGINT", close); process.once("SIGTERM", close);
  }, (error) => {
    process.stderr.write(`Router process failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
