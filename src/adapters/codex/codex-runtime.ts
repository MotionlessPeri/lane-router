import { CodexBackend } from "../../backends/codex-backend.js";
import type { RouterStateStore } from "../../router/state-store.js";
import { LANE_ROUTER_INSTRUCTIONS } from "../../tools/tool-contract.js";
import type { CallerContext } from "../../router/types.js";
import type { ToolCatalog } from "../../application/tool-catalog.js";
import { AppServerClient } from "./app-server-client.js";
import { CodexAppServerProcess, CodexCapabilityGate, type CodexCommand } from "./app-server-process.js";
import { CodexDynamicToolDispatcher, codexDynamicTools } from "./dynamic-tools.js";
import type { DynamicToolCallParams } from "./protocol.js";
import { AccountSwitchGate, type AccountRequestFinish } from "../../accounts/switch-gate.js";
import { AccountConsumer } from "../../accounts/consumer.js";
import { AccountError } from "../../accounts/contracts.js";

export interface CodexProcessControl {
  readonly client: AppServerClient;
  start(): Promise<string>;
  shutdown(): Promise<void>;
  onReconnect(handler: (event?: { strategy?: string }) => void): () => void;
}

export class CodexRuntime {
  readonly client: AppServerClient;
  readonly backend: CodexBackend;
  readonly dynamicTools: ReturnType<typeof codexDynamicTools>;
  readonly accountGate?: AccountSwitchGate;
  private readonly accountConsumer?: AccountConsumer;
  private readonly dispatcher: CodexDynamicToolDispatcher;
  private readonly ownedThreads = new Set<string>();
  private readonly visibleClients = new Map<string, number>();
  private readonly threadCwds = new Map<string, string>();
  private readonly threadStartups = new Map<string, Readonly<{ profile?: string; modelProvider?: string; transient?: boolean }>>();
  private unsubscribeRequest?: () => void;
  private unsubscribeReconnect?: () => void;
  private unsubscribeTransport?: () => void;
  private running = false;
  endpoint = "";

  constructor(private readonly options: {
    readonly state: RouterStateStore;
    readonly callTool: (name: string, args: Record<string, unknown>, context: CallerContext) => unknown | Promise<unknown>;
    readonly catalog?: ToolCatalog;
    readonly process: CodexProcessControl;
    readonly accountConnectionFile?: string;
  }) {
    this.client = options.process.client;
    this.dynamicTools = codexDynamicTools(options.catalog);
    if (options.accountConnectionFile) {
      this.accountGate = new AccountSwitchGate({
        request: (method, params) => this.client.request(method, params),
        onRelease: () => this.backend.reportReconnect(this.knownThreadIds()),
      });
      this.accountConsumer = new AccountConsumer({
        id: "router", connectionFile: options.accountConnectionFile, gate: this.accountGate,
        request: (method, params) => this.client.request(method, params),
      });
    }
    this.backend = new CodexBackend({
      client: {
        request: (method, params) => this.accountGate
          ? this.accountGate.request(method, () => this.client.request(method, params))
          : this.client.request(method, params),
        isConnected: () => this.client.isConnected(),
        onNotification: handler => this.client.onNotification(handler),
      },
      resolveLane: (threadId) => options.state.activeBindingForConversation("codex", threadId)?.laneAddress,
      hasVisibleClient: (threadId) => (this.visibleClients.get(threadId) ?? 0) > 0,
    });
    this.dispatcher = new CodexDynamicToolDispatcher({
      ownsThread: (threadId) => this.ownsThread(threadId),
      cwdForThread: (threadId) => this.threadCwds.get(threadId) ?? startupCwd(this.options.state.activeBindingForConversation("codex", threadId)),
      startupForThread: (threadId) => this.threadStartups.get(threadId),
      call: options.callTool,
      catalog: options.catalog,
    });
  }

  async start(): Promise<string> {
    if (this.running) return this.endpoint;
    this.unsubscribeRequest = this.client.onServerRequest((request) => request.method === "account/chatgptAuthTokens/refresh"
      ? this.refreshAccount(request.params)
      : this.dispatcher.dispatch(request.params));
    this.unsubscribeTransport = this.client.onTransportLoss(() => this.accountConsumer?.runtimeChanged());
    this.unsubscribeReconnect = this.options.process.onReconnect(event => {
      this.accountConsumer?.runtimeChanged(event?.strategy === "respawned");
      this.backend.reportReconnect(this.knownThreadIds());
    });
    try {
      this.endpoint = await this.options.process.start();
      this.accountConsumer?.start();
      this.running = true;
      return this.endpoint;
    } catch (error) {
      this.detach();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running && !this.unsubscribeRequest && !this.unsubscribeReconnect) return;
    this.running = false;
    this.accountConsumer?.close();
    this.detach();
    this.dispatcher.clear();
    await this.options.process.shutdown();
  }

  decorateThreadStart(params: Record<string, unknown>): Record<string, unknown> {
    return { ...params, dynamicTools: this.dynamicTools, developerInstructions: LANE_ROUTER_INSTRUCTIONS };
  }

  claimThread(threadId: string, cwd?: string, startup?: Readonly<{ profile?: string; modelProvider?: string; transient?: boolean }>): void {
    this.ownedThreads.add(threadId);
    if (cwd !== undefined) this.threadCwds.set(threadId, cwd);
    if (startup !== undefined) this.threadStartups.set(threadId, startup);
  }

  openThreadClient(threadId: string): void {
    this.visibleClients.set(threadId, (this.visibleClients.get(threadId) ?? 0) + 1);
  }

  closeThreadClient(threadId: string): void {
    const next = (this.visibleClients.get(threadId) ?? 0) - 1;
    if (next > 0) this.visibleClients.set(threadId, next);
    else this.visibleClients.delete(threadId);
  }

  ownsThread(threadId: string): boolean {
    return this.ownedThreads.has(threadId) || this.options.state.latestBindingForConversation("codex", threadId) !== undefined;
  }

  dispatchTool(request: DynamicToolCallParams): Promise<unknown> {
    return this.dispatcher.dispatch(request);
  }

  admitModelRequest(method: string, admission?: string, params?: unknown): AccountRequestFinish {
    const exportsToken = method === "getAuthStatus" && params !== null && typeof params === "object" && "includeToken" in params && params.includeToken === true;
    if (this.accountConsumer && (exportsToken || ["account/login/start", "account/logout", "loginApiKey", "loginChatGpt", "logout"].includes(method))) throw new AccountError("ACCOUNT_MANAGED_EXTERNALLY");
    return this.accountGate?.enter(method, admission) ?? (() => {});
  }
  modelRequestUncertain(): void { this.accountGate?.markUncertain(); }

  refreshAccount(params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (!this.accountConsumer) return Promise.reject(new AccountError("AUTH_REQUIRED"));
    return this.accountConsumer.refresh(params);
  }

  observeNotification(method: string, params: Readonly<Record<string, unknown>>): void {
    this.backend.observeNotification({ method, params });
  }

  private knownThreadIds(): string[] {
    return [...new Set([...this.ownedThreads, ...this.options.state.activeBindings("codex").map((binding) => binding.conversationId)])];
  }

  private detach(): void {
    this.unsubscribeRequest?.(); this.unsubscribeRequest = undefined;
    this.unsubscribeReconnect?.(); this.unsubscribeReconnect = undefined;
    this.unsubscribeTransport?.(); this.unsubscribeTransport = undefined;
  }
}

export function createCodexRuntime(options: {
  readonly state: RouterStateStore;
  readonly callTool: (name: string, args: Record<string, unknown>, context: CallerContext) => unknown | Promise<unknown>;
  readonly catalog?: ToolCatalog;
  readonly command: CodexCommand;
  readonly capabilityCacheDir: string;
  readonly accountConnectionFile?: string;
}): CodexRuntime {
  const process = new CodexAppServerProcess({ command: options.command, gate: new CodexCapabilityGate({ cacheDir: options.capabilityCacheDir }) });
  return new CodexRuntime({ state: options.state, callTool: options.callTool, catalog: options.catalog, process, accountConnectionFile: options.accountConnectionFile });
}

function startupCwd(binding: ReturnType<RouterStateStore["activeBindingForConversation"]>): string | undefined {
  return typeof binding?.startup.cwd === "string" ? binding.startup.cwd : undefined;
}
