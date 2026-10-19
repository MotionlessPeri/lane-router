import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ZcodeDriver } from "../adapters/zcode/driver/driver.js";
import { ClaudeBackend } from "../backends/claude-backend.js";
import { CodexBackend } from "../backends/codex-backend.js";
import { DshBackend, DshChannelHub } from "../backends/dsh-backend.js";
import { ZcodeBackend } from "../backends/zcode-backend.js";
import { NativeHostBackend } from "../backends/native-host-backend.js";
import { NativeHostService } from "./native-host-service.js";
import { readNativeHostPermits } from "./native-host-permits.js";
import type { NativeHostPermit } from "./native-external-contract.js";
import { BackendRegistry } from "../router/backend.js";
import { dashboardSnapshot, type DashboardLauncherChoices } from "../router/dashboard.js";
import { openRouterDatabase } from "../router/database.js";
import { MailboxStore } from "../router/mailbox-store.js";
import { NotificationPump } from "../router/notification-pump.js";
import { RouterCore } from "../router/router-core.js";
import { RouterStateStore } from "../router/state-store.js";
import { TellAdapter } from "../router/tell.js";
import { ClaudeSessionLocator } from "./claude-session-locator.js";
import { ConversationRestorer } from "./conversation-restorer.js";
import { DashboardLaneOpener } from "./dashboard-lane-opener.js";
import { CLAUDE_LAUNCHER_MODELS } from "./claude-models.js";
import { defaultCodexModelProvider, listCodexModelProviders, listCodexProfiles, profileModelProvider } from "./codex-profiles.js";
import { readRouterConfig } from "./router-config.js";
import { spawnHeadlessZcodeLane } from "./zcode-lane-spawner.js";
import { ToolService } from "../tools/tool-service.js";
import { bindBuiltinTools, communicationToolCatalog, productToolCatalog } from "../application/builtin-tools.js";
import type { ApplicationTools } from "../application/tool-catalog.js";
import { openIssuesModule } from "../modules/issues/index.js";
import { openGraphs } from "../modules/graphs/index.js";
import { ClaudeChannelHub, LocalRouterServer } from "./local-server.js";
import { RuntimeLock } from "./runtime-lock.js";
import { buildId } from "./build-id.js";
import { CodexHostHub } from "./codex-host-hub.js";
import { CodexHostKeeper } from "./codex-host-keeper.js";
import { ensureCodexHost } from "./ensure-codex-host.js";

export async function runRouterProcess(options: {
  dataRoot?: string; nativeHosts?: readonly NativeHostPermit[]; issues?: boolean;
  /** Replaces starting the detached Codex host; tests assemble their own host in-process. */
  ensureCodexHost?: (dataRoot: string) => Promise<unknown>;
  build?: string;
} = {}): Promise<{ close(): Promise<void> }> {
  const dataRoot = options.dataRoot ?? process.env.LANE_ROUTER_DATA_ROOT ?? join(homedir(), ".lane-router");
  mkdirSync(dataRoot, { recursive: true });
  const lock = RuntimeLock.acquire(join(dataRoot, "router.lock"));
  if (!lock) throw new Error("Another Router process is already running");
  let database: ReturnType<typeof openRouterDatabase>;
  try { database = openRouterDatabase(join(dataRoot, "router.sqlite")); }
  catch (error) { lock.release(); throw error; }
  const state = new RouterStateStore(database);
  const mailbox = new MailboxStore(dataRoot);
  // The channel hub knows a conversation only by id, but a ZCode session riding that hub stores its
  // binding under "zcode", so a claude-only lookup would leave every zcode channel binding-less and
  // reach/notify blind. Claude answers first: it is the hub's native backend, and the same id bound
  // under both names is not a state any session can produce.
  const activeChannelBinding = (conversationId: string) =>
    state.activeBindingForConversation("claude", conversationId)
      ?? state.activeBindingForConversation("zcode", conversationId);
  const claudeHub = new ClaudeChannelHub(activeChannelBinding);
  const claudeBackend = new ClaudeBackend(claudeHub);
  // Constructed but never started here: the driver spawns its app-server on first use, so a missing
  // or broken zcode install costs exactly the features that need it and never the Router's boot.
  // A config file that exists but does not parse is an operator error the Router must refuse to
  // run on, so the read sits inside the lock-owning lifecycle rather than before it.
  const configuration = await (async () => {
    const config = await readRouterConfig({ dataRoot });
    const nativeHosts = await readNativeHostPermits({ dataRoot, nativeHostsFile: config.nativeHostsFile, nativeHosts: options.nativeHosts });
    return { config, nativeHosts };
  })().catch((error: unknown) => {
    database.close(); lock.release(); throw error;
  });
  const zcodeDriverConfig = configuration.config.zcode?.driver;
  const zcodeDriver = zcodeDriverConfig === undefined ? undefined : new ZcodeDriver({
    launch: {
      command: zcodeDriverConfig.command,
      ...(zcodeDriverConfig.args === undefined ? {} : { args: zcodeDriverConfig.args }),
      ...(zcodeDriverConfig.env === undefined ? {} : { env: zcodeDriverConfig.env }),
    },
    plan: zcodeDriverConfig.plan,
    ...(zcodeDriverConfig.builtinPath === undefined ? {} : { builtinConfigPath: zcodeDriverConfig.builtinPath }),
    ...(zcodeDriverConfig.personalPath === undefined ? {} : { personalConfigPath: zcodeDriverConfig.personalPath }),
    credentialsPath: zcodeDriverConfig.credentialsPath,
    ...(zcodeDriverConfig.host === undefined ? {} : { host: zcodeDriverConfig.host }),
    onLog: (line) => process.stderr.write(`${line}\n`),
    onStderrLine: (line) => process.stderr.write(`zcode app-server: ${line}\n`),
  });
  const zcodeBackend = new ZcodeBackend(
    claudeHub,
    zcodeDriver,
    (sessionId) => state.activeBindingForConversation("zcode", sessionId)?.laneAddress,
  );
  const dshHub = new DshChannelHub((sessionId) => state.activeBindingForConversation("dsh", sessionId));
  const dshBackend = new DshBackend(dshHub);
  const nativeHostBackend = new NativeHostBackend(id => state.activeBindingForConversation("native-codex", id));
  let nativeHost: NativeHostService | undefined;
  let tools: ToolService | undefined;
  const catalog = options.issues === false ? communicationToolCatalog : productToolCatalog;
  let applicationTools: ApplicationTools | undefined;
  let issues: ReturnType<typeof openIssuesModule> | undefined;
  let graphs: ReturnType<typeof openGraphs> | undefined;
  let graphOrigin: string | undefined;
  let server: LocalRouterServer | undefined;
  const discoveryPath = join(dataRoot, "discovery.json");
  let closed = false;
  // The Codex host lives in its own process and outlives this one: nothing here starts or stops an
  // App Server. The core only serves the host's link and makes sure some host exists.
  const hostKeeper = new CodexHostKeeper({
    ensureHost: () => (options.ensureCodexHost ?? ((root: string) => ensureCodexHost({ dataRoot: root })))(dataRoot),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const closeResources = async (): Promise<void> => {
    let failure: unknown;
    const attempt = async (work: () => unknown | Promise<unknown>) => { try { await work(); } catch (error) { failure ??= error; } };
    hostKeeper.stop();
    // Drain module work while core storage and delivery backends are still available.
    await attempt(() => issues?.close());
    await attempt(() => server?.close());
    await attempt(() => graphs?.close());
    await attempt(() => nativeHost?.close());
    await attempt(() => zcodeDriver?.shutdown());
    try { database.close(); } finally { lock.release(); }
    if (failure !== undefined) throw failure;
  };
  try {
    const dshToken = loadDshHostToken(dataRoot);
    let codexBackend: CodexBackend | undefined;
    const codexHub = new CodexHostHub({
      state, build: options.build ?? buildId(),
      callTool: (name, args, context, signal) => {
        if (!applicationTools) throw new Error("Router tools are not ready");
        return applicationTools.call(name, args, context, signal);
      },
      opportunity: (threadIds) => codexBackend?.reportReconnect(threadIds),
      onHostLost: () => hostKeeper.ensure(),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    codexBackend = new CodexBackend({
      client: codexHub.client,
      resolveLane: (threadId) => state.activeBindingForConversation("codex", threadId)?.laneAddress,
      hasVisibleClient: (threadId) => codexHub.hasVisibleClient(threadId),
    });
    // Codex models come from the host's App Server, which may not be linked yet — or ever, on a
    // machine without Codex — so the menu starts without them and fills in once the host is ready.
    let launcherChoices = baseLauncherChoices();
    codexHub.onReady(() => {
      void codexModels(codexHub.client).then((models) => {
        launcherChoices = { ...launcherChoices, models: [...CLAUDE_LAUNCHER_MODELS, ...models] };
      }, (error: unknown) => {
        process.stderr.write(`Codex model list unavailable: ${error instanceof Error ? error.message : "unknown error"}\n`);
      });
    });
    const backends = new BackendRegistry([claudeBackend, codexBackend, dshBackend, zcodeBackend, nativeHostBackend]);
    const pump = new NotificationPump(state, mailbox, backends);
    const restore = new ConversationRestorer({
      state, backends,
      claudeSessions: new ClaudeSessionLocator(join(homedir(), ".claude", "projects")),
      fallbackCwd: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      dataRoot,
    });
    const core = new RouterCore({ state, mailbox, backends, pump, restore, newId: () => randomUUID(), now: Date.now });
    const teller = new TellAdapter({
      delivery: core, latestProjectCwd: (project) => state.latestProjectCwd(project),
      newRequestKey: () => `tell:${randomUUID()}`,
    });
    const dashboardOpener = new DashboardLaneOpener({
      state,
      restore,
      overrideChoices: {
        get models() { return launcherChoices.models.map((model) => model.id); },
        get profiles() { return launcherChoices.profiles.map((profile) => profile.name); },
        get modelProviders() { return launcherChoices.modelProviders; },
      },
      resolveProfileProvider: profileModelProvider,
    });
    tools = new ToolService(core);
    if (options.issues !== false) {
      try {
        issues = openIssuesModule({ databasePath: join(dataRoot, "issues.sqlite"), lanes: core, delivery: core,
          onError: error => process.stderr.write(`Issues module: ${error instanceof Error ? error.message : "unknown error"}\n`) });
      } catch (error) {
        process.stderr.write(`ISSUES_UNAVAILABLE: ${error instanceof Error ? error.message : "unknown error"}\n`);
      }
    }
    if (options.issues !== false) {
      try { graphs = openGraphs(join(dataRoot, "graphs.sqlite"), core); }
      catch (error) { process.stderr.write(`GRAPHS_UNAVAILABLE: ${error instanceof Error ? error.message : "unknown error"}\n`); }
    }
    applicationTools = bindBuiltinTools(tools, issues?.service, catalog, graphs?.service, () => graphOrigin);
    if (configuration.nativeHosts !== undefined) nativeHost = new NativeHostService({
      permits: configuration.nativeHosts, state, core, tools, backend: nativeHostBackend,
      attention: lane => pump.onAttentionOpportunity(lane),
    });
    mailbox.reconcile(state);
    if (issues) {
      try { await issues.start(); }
      catch (error) {
        await issues.close().catch(() => undefined); issues = undefined;
        applicationTools = bindBuiltinTools(tools, undefined, catalog, graphs?.service, () => graphOrigin);
        process.stderr.write(`ISSUES_UNAVAILABLE: ${error instanceof Error ? error.message : "unknown error"}\n`);
      }
    }
    server = new LocalRouterServer({
      tools, applicationTools, codexHost: codexHub, claude: claudeHub, instanceId: randomUUID(),
      ...(options.issues === false ? {} : { issues: { service: issues?.service } }),
      ...(options.issues === false ? {} : { graphs: { service: graphs?.service } }),
      nativeHost,
      dsh: { token: dshToken, channel: dshHub, read: (context, messageIds) => core.read(context, { messageIds }),
        handoff: (context, input) => core.handoffDsh(context, input) },
      // The cwd travels with whichever backend owns the binding, so the channel resolver decides
      // where the fact lands rather than the /claude path assuming it is always "claude".
      recordCwd: (conversationId, cwd) => {
        const binding = activeChannelBinding(conversationId);
        if (binding !== undefined) state.updateBindingCwd(binding.backend, conversationId, cwd);
      },
      pendingSummary: (conversationId) => {
        // The channel resolver, not a claude-only lookup: a ZCode session rides the Claude channel
        // but its binding is stored under "zcode", and this nudge is the only wake its sessions get.
        const binding = activeChannelBinding(conversationId);
        return binding === undefined ? undefined : { laneAddress: binding.laneAddress, pendingCount: mailbox.pendingCount(binding.laneAddress) };
      },
      resumeInfo: (address) => core.resumeInfo(address),
      archiveLane: (address) => core.archiveLane(address),
      listArchivedLanes: (project) => core.listArchivedLanes(project),
      tell: (input) => teller.tell(input),
      ...(zcodeDriver === undefined ? {} : {
        zcodeSpawnLane: (input) => spawnHeadlessZcodeLane({
          driver: zcodeDriver,
          callTool: (name, args, context) => {
            if (!tools) throw new Error("Router tools are not ready");
            return tools.call(name, args, context);
          },
          input,
        }),
      }),
      dashboardState: (router) => dashboardSnapshot({ state, mailbox, backends, now: Date.now, launcherChoices, codexHost: () => codexHub.status() }, router),
      dashboardOpen: (input) => dashboardOpener.open(input),
      dashboardLaneSets: async (input) => {
        if (input.action === "create") core.createLaneSet(input.name);
        else if (input.action === "delete") core.deleteLaneSet(input.setId);
        else core.assignLaneSet(input.addresses, input.setId);
        return { laneSets: core.listLaneSets() };
      },
    });
    const discovery = await server.start();
    graphOrigin = discovery.url;
    writeDiscovery(discoveryPath, discovery);
    for (const backend of [claudeBackend, codexBackend, dshBackend, zcodeBackend]) backend.onAttentionOpportunity((lane) => { void pump.onAttentionOpportunity(lane); });
    await pump.onStartup();
    // After discovery, never before: the host finds this core through that file, so a core that
    // waited for its host first would wait forever.
    hostKeeper.ensure();
  } catch (error) {
    await closeResources().catch(() => undefined);
    throw error;
  }

  return { close: async () => {
    if (closed) return; closed = true;
    rmSync(discoveryPath, { force: true });
    await closeResources();
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

function baseLauncherChoices(): DashboardLauncherChoices {
  return {
    defaultModelProvider: defaultCodexModelProvider(),
    // Claude first: its four aliases are the short, stable end of the list, and burying them under
    // however many models Codex reports would leave them unfindable in the menu.
    models: [...CLAUDE_LAUNCHER_MODELS],
    profiles: listCodexProfiles(),
    modelProviders: listCodexModelProviders(),
  };
}

async function codexModels(client: { request(method: string, params: unknown): Promise<unknown> }): Promise<DashboardLauncherChoices["models"]> {
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
  return models;
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
