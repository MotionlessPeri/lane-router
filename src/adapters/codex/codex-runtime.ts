import { CodexBackend } from "../../backends/codex-backend.js";
import type { RouterStateStore } from "../../router/state-store.js";
import { LANE_ROUTER_INSTRUCTIONS } from "../../tools/tool-contract.js";
import type { CallerContext } from "../../router/types.js";
import type { LaneToolName } from "../../tools/tool-contract.js";
import { AppServerClient } from "./app-server-client.js";
import { CodexAppServerProcess, CodexCapabilityGate, type CodexCommand } from "./app-server-process.js";
import { CodexDynamicToolDispatcher, codexDynamicTools } from "./dynamic-tools.js";
import type { DynamicToolCallParams } from "./protocol.js";

export interface CodexProcessControl {
  readonly client: AppServerClient;
  start(): Promise<string>;
  shutdown(): Promise<void>;
  onReconnect(handler: () => void): () => void;
}

export class CodexRuntime {
  readonly client: AppServerClient;
  readonly backend: CodexBackend;
  readonly dynamicTools = codexDynamicTools();
  private readonly dispatcher: CodexDynamicToolDispatcher;
  private readonly ownedThreads = new Set<string>();
  private readonly visibleClients = new Map<string, number>();
  private readonly threadCwds = new Map<string, string>();
  private unsubscribeRequest?: () => void;
  private unsubscribeReconnect?: () => void;
  private running = false;
  endpoint = "";

  constructor(private readonly options: {
    readonly state: RouterStateStore;
    readonly callTool: (name: LaneToolName, args: Record<string, unknown>, context: CallerContext) => unknown | Promise<unknown>;
    readonly process: CodexProcessControl;
  }) {
    this.client = options.process.client;
    this.backend = new CodexBackend({
      client: this.client,
      resolveLane: (threadId) => options.state.activeBindingForConversation("codex", threadId)?.laneAddress,
      hasVisibleClient: (threadId) => (this.visibleClients.get(threadId) ?? 0) > 0,
    });
    this.dispatcher = new CodexDynamicToolDispatcher({
      ownsThread: (threadId) => this.ownsThread(threadId),
      cwdForThread: (threadId) => this.threadCwds.get(threadId) ?? startupCwd(this.options.state.activeBindingForConversation("codex", threadId)),
      call: options.callTool,
    });
  }

  async start(): Promise<string> {
    if (this.running) return this.endpoint;
    this.unsubscribeRequest = this.client.onServerRequest((request) => this.dispatcher.dispatch(request.params));
    this.unsubscribeReconnect = this.options.process.onReconnect(() => {
      this.backend.reportReconnect(this.knownThreadIds());
    });
    try {
      this.endpoint = await this.options.process.start();
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
    this.detach();
    this.dispatcher.clear();
    await this.options.process.shutdown();
  }

  decorateThreadStart(params: Record<string, unknown>): Record<string, unknown> {
    return { ...params, dynamicTools: this.dynamicTools, developerInstructions: LANE_ROUTER_INSTRUCTIONS };
  }

  claimThread(threadId: string, cwd?: string): void {
    this.ownedThreads.add(threadId);
    if (cwd !== undefined) this.threadCwds.set(threadId, cwd);
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

  observeNotification(method: string, params: Readonly<Record<string, unknown>>): void {
    this.backend.observeNotification({ method, params });
  }

  private knownThreadIds(): string[] {
    return [...new Set([...this.ownedThreads, ...this.options.state.activeBindings("codex").map((binding) => binding.conversationId)])];
  }

  private detach(): void {
    this.unsubscribeRequest?.(); this.unsubscribeRequest = undefined;
    this.unsubscribeReconnect?.(); this.unsubscribeReconnect = undefined;
  }
}

export function createCodexRuntime(options: {
  readonly state: RouterStateStore;
  readonly callTool: (name: LaneToolName, args: Record<string, unknown>, context: CallerContext) => unknown | Promise<unknown>;
  readonly command: CodexCommand;
  readonly capabilityCacheDir: string;
}): CodexRuntime {
  const process = new CodexAppServerProcess({ command: options.command, gate: new CodexCapabilityGate({ cacheDir: options.capabilityCacheDir }) });
  return new CodexRuntime({ state: options.state, callTool: options.callTool, process });
}

function startupCwd(binding: ReturnType<RouterStateStore["activeBindingForConversation"]>): string | undefined {
  return typeof binding?.startup.cwd === "string" ? binding.startup.cwd : undefined;
}
