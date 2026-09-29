import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCodexRuntime } from "../adapters/codex/codex-runtime.js";
import { ClaudeBackend } from "../backends/claude-backend.js";
import { DshBackend, DshChannelHub } from "../backends/dsh-backend.js";
import { BackendRegistry } from "../router/backend.js";
import { dashboardSnapshot, type DashboardLauncherChoices } from "../router/dashboard.js";
import { openRouterDatabase } from "../router/database.js";
import { MailboxStore } from "../router/mailbox-store.js";
import { NotificationPump } from "../router/notification-pump.js";
import { RouterCore } from "../router/router-core.js";
import { RouterStateStore } from "../router/state-store.js";
import { ClaudeSessionLocator } from "./claude-session-locator.js";
import { ConversationRestorer } from "./conversation-restorer.js";
import { DashboardLaneOpener } from "./dashboard-lane-opener.js";
import { CLAUDE_LAUNCHER_MODELS } from "./claude-models.js";
import { defaultCodexModelProvider, listCodexModelProviders, listCodexProfiles, profileModelProvider } from "./codex-profiles.js";
import { ToolService } from "../tools/tool-service.js";
import { ClaudeChannelHub, LocalRouterServer } from "./local-server.js";
import { RuntimeLock } from "./runtime-lock.js";

export async function runRouterProcess(options: { dataRoot?: string } = {}): Promise<{ close(): Promise<void> }> {
  const dataRoot = options.dataRoot ?? process.env.LANE_ROUTER_DATA_ROOT ?? join(homedir(), ".lane-router");
  mkdirSync(dataRoot, { recursive: true });
  const lock = RuntimeLock.acquire(join(dataRoot, "router.lock"));
  if (!lock) throw new Error("Another Router process is already running");
  let database: ReturnType<typeof openRouterDatabase>;
  try { database = openRouterDatabase(join(dataRoot, "router.sqlite")); }
  catch (error) { lock.release(); throw error; }
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(dataRoot);
  const claudeHub = new ClaudeChannelHub((conversationId) => state.activeBindingForConversation("claude", conversationId));
  const claudeBackend = new ClaudeBackend(claudeHub);
  const dshHub = new DshChannelHub((sessionId) => state.activeBindingForConversation("dsh", sessionId));
  const dshBackend = new DshBackend(dshHub);
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
    const dshToken = loadDshHostToken(dataRoot);
    await codex.start();
    const launcherChoices = await codexLauncherChoices(codex.client);
    const backends = new BackendRegistry([claudeBackend, codex.backend, dshBackend]);
    const pump = new NotificationPump(state, mailbox, backends);
    const restore = new ConversationRestorer({
      state, backends,
      claudeSessions: new ClaudeSessionLocator(join(homedir(), ".claude", "projects")),
      fallbackCwd: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      dataRoot,
    });
    const core = new RouterCore({ state, mailbox, backends, pump, restore, newId: () => randomUUID(), now: Date.now });
    const dashboardOpener = new DashboardLaneOpener({
      state,
      restore,
      overrideChoices: {
        models: launcherChoices.models.map((model) => model.id),
        profiles: launcherChoices.profiles.map((profile) => profile.name),
        modelProviders: launcherChoices.modelProviders,
      },
      resolveProfileProvider: profileModelProvider,
    });
    tools = new ToolService(core);
    server = new LocalRouterServer({
      tools, codex, claude: claudeHub, instanceId: randomUUID(),
      dsh: { token: dshToken, channel: dshHub, read: (context, messageIds) => core.read(context, { messageIds }),
        handoff: (context, input) => core.handoffDsh(context, input) },
      recordCwd: (conversationId, cwd) => state.updateBindingCwd("claude", conversationId, cwd),
      resumeInfo: (address) => core.resumeInfo(address),
      archiveLane: (address) => core.archiveLane(address),
      listArchivedLanes: (project) => core.listArchivedLanes(project),
      dashboardState: (router) => dashboardSnapshot({ state, mailbox, backends, now: Date.now, launcherChoices }, router),
      dashboardOpen: (input) => dashboardOpener.open(input),
    });
    mailbox.reconcile(state);
    const discovery = await server.start();
    writeDiscovery(discoveryPath, discovery);
    for (const backend of [claudeBackend, codex.backend, dshBackend]) backend.onAttentionOpportunity((lane) => { void pump.onAttentionOpportunity(lane); });
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

/** Loads or creates the private bearer credential shared with the trusted local DSH Host. */
export function loadDshHostToken(dataRoot: string): string {
  const path = join(dataRoot, "dsh-host.token");
  if (!existsSync(path)) writeFileSync(path, `${randomBytes(32).toString("base64url")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  restrictTokenPermissions(path);
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error("DSH Host token is empty");
  return token;
}

function restrictTokenPermissions(path: string): void {
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
    return;
  }
  const command = windowsTokenAclCommand(path);
  const result = execFileSync(command.executable, command.args, { encoding: "utf8", windowsHide: true });
  parseWindowsTokenAclResult(result);
}

const WINDOWS_TOKEN_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = (Resolve-Path -LiteralPath $args[0]).Path
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$grant = "*$($current.Value):(F)"
& icacls.exe $path /inheritance:r /grant:r $grant | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed with exit code $LASTEXITCODE" }
$actual = Get-Acl -LiteralPath $path
function Get-SidValue([object]$identity) {
  if ($identity -is [System.Security.Principal.SecurityIdentifier]) { return $identity.Value }
  return ([System.Security.Principal.NTAccount]::new($identity.ToString())).Translate([System.Security.Principal.SecurityIdentifier]).Value
}
$rules = @($actual.Access | ForEach-Object {
  [pscustomobject]@{
    sid = Get-SidValue $_.IdentityReference
    type = $_.AccessControlType.ToString()
    fullControl = (($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)
    inherited = $_.IsInherited
  }
})
[pscustomobject]@{
  currentSid = $current.Value
  ownerSid = Get-SidValue $actual.Owner
  protected = $actual.AreAccessRulesProtected
  rules = $rules
} | ConvertTo-Json -Compress -Depth 4
`.trim();

/** Builds the Windows ACL command with the file path passed as data rather than script text. */
export function windowsTokenAclCommand(path: string): { executable: string; args: string[] } {
  return { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", `& { ${WINDOWS_TOKEN_ACL_SCRIPT} }`, path] };
}

/** Rejects any Windows token ACL that grants access beyond the current owner. */
export function parseWindowsTokenAclResult(raw: string): void {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Windows DSH token ACL verification returned invalid output"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Windows DSH token ACL verification returned invalid output");
  const result = value as Record<string, unknown>;
  const rules = result.rules;
  const ownerOnly = typeof result.currentSid === "string"
    && result.ownerSid === result.currentSid
    && result.protected === true
    && Array.isArray(rules)
    && rules.length === 1
    && typeof rules[0] === "object"
    && rules[0] !== null
    && (rules[0] as Record<string, unknown>).sid === result.currentSid
    && (rules[0] as Record<string, unknown>).type === "Allow"
    && (rules[0] as Record<string, unknown>).fullControl === true
    && (rules[0] as Record<string, unknown>).inherited === false;
  if (!ownerOnly) throw new Error("Windows DSH token ACL is not owner-only");
}

async function codexLauncherChoices(client: { request(method: string, params: unknown): Promise<unknown> }): Promise<DashboardLauncherChoices> {
  const models: DashboardLauncherChoices["models"][number][] = [];
  let cursor: string | undefined;
  do {
    const response = await client.request("model/list", { includeHidden: true, ...(cursor === undefined ? {} : { cursor }) });
    const data = responseProperty(response, "data");
    if (!Array.isArray(data)) throw new Error("Codex App Server model/list returned no model array");
    for (const entry of data) {
      if (typeof entry !== "object" || entry === null) throw new Error("Codex App Server model/list returned an invalid model");
      const model = entry as Record<string, unknown>;
      if (typeof model.id !== "string" || typeof model.displayName !== "string" || typeof model.hidden !== "boolean") {
        throw new Error("Codex App Server model/list returned an invalid model");
      }
      models.push({ id: model.id, displayName: model.displayName, hidden: model.hidden, backend: "codex" });
    }
    const next = responseProperty(response, "nextCursor");
    if (next !== null && typeof next !== "string") throw new Error("Codex App Server model/list returned an invalid cursor");
    cursor = next ?? undefined;
  } while (cursor !== undefined && models.length < 10_000);
  return {
    defaultModelProvider: defaultCodexModelProvider(),
    // Claude first: its four aliases are the short, stable end of the list, and burying them under
    // however many models Codex reports would leave them unfindable in the menu.
    models: [...CLAUDE_LAUNCHER_MODELS, ...models],
    profiles: listCodexProfiles(),
    modelProviders: listCodexModelProviders(),
  };
}

function responseProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null) throw new Error("Codex App Server model/list returned no object");
  return (value as Record<string, unknown>)[property];
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
