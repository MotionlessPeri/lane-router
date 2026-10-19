import { LANE_ROUTER_INSTRUCTIONS } from "../../tools/tool-contract.js";
import type { CallerContext } from "../../router/types.js";
import type { ToolCatalog } from "../../application/tool-catalog.js";
import { AppServerClient } from "./app-server-client.js";
import { CodexAppServerProcess, CodexCapabilityGate, type CodexCommand, type CodexProcessState } from "./app-server-process.js";
import { CodexDynamicToolDispatcher, codexDynamicTools } from "./dynamic-tools.js";
import { CODEX_HOST_PROTOCOL_VERSION, CORE_APP_SERVER_METHODS, type HostHello } from "./host-protocol.js";
import type { DynamicToolCallParams } from "./protocol.js";
import { AccountSwitchGate, type AccountRequestFinish } from "../../accounts/switch-gate.js";
import { AccountConsumer } from "../../accounts/consumer.js";
import { AccountError } from "../../accounts/contracts.js";

export interface CodexProcessControl {
  readonly client: AppServerClient;
  readonly state?: CodexProcessState;
  /** The App Server's endpoint right now, which a respawn changes. */
  readonly endpoint?: string;
  start(): Promise<string>;
  shutdown(): Promise<void>;
  onReconnect(handler: (event?: { strategy?: string }) => void): () => void;
}

/**
 * What the host needs from the Router core. Every call is allowed to fail at once: when the core
 * is not there, a lane tool must say so immediately rather than hold the model's turn open.
 */
export interface CodexCoreLink {
  callTool(name: string, args: Record<string, unknown>, context: CallerContext): Promise<unknown>;
  ownsThread(threadId: string): Promise<boolean>;
  /** Fire-and-forget; dropped while the core is away, and made good by the next hello. */
  event(method: string, params: Record<string, unknown>): void;
}

type ThreadStartup = Readonly<{ profile?: string; modelProvider?: string; transient?: boolean }>;

/** The notifications the core's Codex backend acts on; nothing else is worth a frame. */
const CONSUMED_NOTIFICATIONS = new Set(["turn/completed", "thread/status/changed"]);

/**
 * The Codex side of the host process: the App Server's owner, the account consumer that has to
 * sit on that owner's connection, and the per-thread facts only the bridge sees. Everything that
 * needs Router state — lane bindings, tools, mailboxes — is asked of the core over the link.
 */
export class CodexRuntime {
  readonly client: AppServerClient;
  readonly dynamicTools: ReturnType<typeof codexDynamicTools>;
  readonly accountGate?: AccountSwitchGate;
  private readonly accountConsumer?: AccountConsumer;
  private readonly dispatcher: CodexDynamicToolDispatcher;
  private readonly claims = new Map<string, { cwd?: string; startup?: ThreadStartup }>();
  private readonly visibleClients = new Map<string, number>();
  private unsubscribers: Array<() => void> = [];
  private running = false;
  private startedEndpoint = "";

  /**
   * Read by every bridge for every new TUI connection, so it must follow the App Server across a
   * respawn onto a new port. Before the host existed a Router restart reset it; the host outlives
   * those, so a value captured once would strand every later TUI until the host was replaced.
   */
  get endpoint(): string { return this.options.process.endpoint ?? this.startedEndpoint; }

  constructor(private readonly options: {
    readonly core: CodexCoreLink;
    readonly catalog?: ToolCatalog;
    readonly process: CodexProcessControl;
    readonly accountConnectionFile?: string;
  }) {
    this.client = options.process.client;
    this.dynamicTools = codexDynamicTools(options.catalog);
    if (options.accountConnectionFile) {
      this.accountGate = new AccountSwitchGate({
        request: (method, params) => this.client.request(method, params),
        onRelease: () => this.offerOpportunity(),
      });
      this.accountConsumer = new AccountConsumer({
        id: "router", connectionFile: options.accountConnectionFile, gate: this.accountGate,
        request: (method, params) => this.client.request(method, params),
      });
    }
    // Ownership is this host's claims alone: every thread its App Server runs a turn for was
    // started or resumed through one of its bridges, which is exactly when a claim is made.
    this.dispatcher = new CodexDynamicToolDispatcher({
      ownsThread: (threadId) => this.claims.has(threadId),
      cwdForThread: (threadId) => this.claims.get(threadId)?.cwd,
      startupForThread: (threadId) => this.claims.get(threadId)?.startup,
      call: (name, args, context) => options.core.callTool(name, args, context),
      catalog: options.catalog,
    });
  }

  async start(): Promise<string> {
    if (this.running) return this.endpoint;
    this.unsubscribers = [
      this.client.onServerRequest((request) => request.method === "account/chatgptAuthTokens/refresh"
        ? this.refreshAccount(request.params)
        : this.dispatchTool(request.params)),
      this.client.onNotification((message) => this.observeNotification(message.method, message.params)),
      this.client.onTransportLoss(() => {
        this.accountConsumer?.runtimeChanged();
        this.options.core.event("appServer", { state: "recovering" });
      }),
      this.options.process.onReconnect((event) => {
        this.accountConsumer?.runtimeChanged(event?.strategy === "respawned");
        this.options.core.event("appServer", { state: "ready" });
        this.offerOpportunity();
      }),
    ];
    try {
      this.startedEndpoint = await this.options.process.start();
      this.accountConsumer?.start();
      this.running = true;
      return this.endpoint;
    } catch (error) {
      this.detach();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running && this.unsubscribers.length === 0) return;
    this.running = false;
    this.accountConsumer?.close();
    this.detach();
    this.dispatcher.clear();
    await this.options.process.shutdown();
  }

  decorateThreadStart(params: Record<string, unknown>): Record<string, unknown> {
    return { ...params, dynamicTools: this.dynamicTools, developerInstructions: LANE_ROUTER_INSTRUCTIONS };
  }

  claimThread(threadId: string, cwd?: string, startup?: ThreadStartup): void {
    const claim = this.claims.get(threadId) ?? {};
    if (cwd !== undefined) claim.cwd = cwd;
    if (startup !== undefined) claim.startup = startup;
    this.claims.set(threadId, claim);
  }

  openThreadClient(threadId: string): void {
    this.setVisibleClients(threadId, (this.visibleClients.get(threadId) ?? 0) + 1);
  }

  closeThreadClient(threadId: string): void {
    this.setVisibleClients(threadId, Math.max(0, (this.visibleClients.get(threadId) ?? 0) - 1));
  }

  ownsThread(threadId: string): boolean | Promise<boolean> {
    return this.claims.has(threadId) || this.options.core.ownsThread(threadId);
  }

  /**
   * A failure goes back as a failed result rather than a JSON-RPC error: the App Server answers the
   * model with a bare "dynamic tool request failed" for an error (measured with codex 0.154.0), and
   * the reason — above all "Lane Router is not running" — is what the model needs to act on.
   */
  dispatchTool(request: DynamicToolCallParams): Promise<unknown> {
    return this.dispatcher.dispatch(request).catch((error: unknown) => ({
      success: false as const,
      contentItems: [{ type: "inputText" as const, text: error instanceof Error ? error.message : String(error) }],
    }));
  }

  admitModelRequest(method: string, admission?: string, params?: unknown): AccountRequestFinish {
    const exportsToken = method === "getAuthStatus" && params !== null && typeof params === "object" && "includeToken" in params && params.includeToken === true;
    if (this.accountConsumer && (exportsToken || ["account/login/start", "account/logout", "loginApiKey", "loginChatGpt", "logout"].includes(method))) throw new AccountError("ACCOUNT_MANAGED_EXTERNALLY");
    return this.accountGate?.enter(method, admission) ?? (() => {});
  }

  refreshAccount(params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (!this.accountConsumer) return Promise.reject(new AccountError("AUTH_REQUIRED"));
    return this.accountConsumer.refresh(params);
  }

  observeNotification(method: string, params: Readonly<Record<string, unknown>>): void {
    if (CONSUMED_NOTIFICATIONS.has(method)) this.options.core.event("observe", { method, params });
  }

  /**
   * The core's way into the App Server, for delivering notifications and judging takeovers. Model
   * requests take the same account gate a TUI's do, so a switch in progress defers a notification
   * instead of starting a turn under the wrong account.
   */
  appServerRequest(method: string, params: unknown): Promise<unknown> {
    if (!(CORE_APP_SERVER_METHODS as readonly string[]).includes(method)) {
      return Promise.reject(new Error(`App Server method ${method} is not allowed over the Codex host link`));
    }
    return this.accountGate
      ? this.accountGate.request(method, () => this.client.request(method, params))
      : this.client.request(method, params);
  }

  hello(identity: { readonly instanceId: string; readonly pid: number; readonly build: string }): HostHello {
    const threadIds = [...new Set([...this.claims.keys(), ...this.visibleClients.keys()])];
    return {
      protocolVersion: CODEX_HOST_PROTOCOL_VERSION, ...identity,
      appServer: this.options.process.state ?? (this.running ? "ready" : "stopped"),
      threads: threadIds.map((threadId) => ({ threadId, visibleClients: this.visibleClients.get(threadId) ?? 0 })),
    };
  }

  private setVisibleClients(threadId: string, count: number): void {
    if (count > 0) this.visibleClients.set(threadId, count);
    else this.visibleClients.delete(threadId);
    this.options.core.event("threadClients", { threadId, visibleClients: count });
  }

  private offerOpportunity(): void {
    this.options.core.event("opportunity", { threadIds: [...this.claims.keys()] });
  }

  private detach(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
  }
}

export function createCodexRuntime(options: {
  readonly core: CodexCoreLink;
  readonly catalog?: ToolCatalog;
  readonly command: CodexCommand;
  readonly capabilityCacheDir: string;
  readonly accountConnectionFile?: string;
}): CodexRuntime {
  const appServer = new CodexAppServerProcess({ command: options.command, gate: new CodexCapabilityGate({ cacheDir: options.capabilityCacheDir }) });
  const process: CodexProcessControl = {
    get client() { return appServer.client; },
    get state() { return appServer.state; },
    get endpoint() { return appServer.currentEndpoint; },
    start: () => appServer.start(),
    shutdown: () => appServer.shutdown(),
    onReconnect: (handler) => appServer.onReconnect(handler),
  };
  return new CodexRuntime({ core: options.core, catalog: options.catalog, process, accountConnectionFile: options.accountConnectionFile });
}
