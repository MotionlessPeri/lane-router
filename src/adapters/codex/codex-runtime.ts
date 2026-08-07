import type { AdapterDeliveryRequest } from "../../core/adapter-contract.js";
import type { BrokerService } from "../../broker/broker-service.js";
import { ToolService } from "../../tools/tool-service.js";
import type { LaneToolName, ToolBindingContext } from "../../tools/tool-contract.js";
import { AppServerClient } from "./app-server-client.js";
import { CodexAppServerProcess, CodexCapabilityGate, type CodexCommand } from "./app-server-process.js";
import { CodexAdapter } from "./codex-adapter.js";
import { CodexDynamicToolDispatcher, codexDynamicTools } from "./dynamic-tools.js";

export interface CodexProcessControl {
  readonly client: AppServerClient;
  start(): Promise<string>;
  shutdown(): Promise<void>;
  onReconnect(handler: () => void): () => void;
}

export interface CodexBindingRegistration {
  readonly laneId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly threadId: string;
}

export class CodexRuntime {
  readonly client: AppServerClient;
  readonly adapter: CodexAdapter;
  readonly dynamicTools = codexDynamicTools();
  private readonly tools: ToolService;
  private readonly dispatcher: CodexDynamicToolDispatcher;
  private readonly byThread = new Map<string, CodexBindingRegistration>();
  private readonly byLaneGeneration = new Map<string, CodexBindingRegistration>();
  private reconnectSequence = 0;
  private unsubscribers: Array<() => void> = [];
  private running = false;
  private startTask?: Promise<string>;
  private stopTask?: Promise<void>;

  constructor(private readonly options: { broker: BrokerService; process: CodexProcessControl; adminId: string; beforeClaim?: (request: AdapterDeliveryRequest, turnId: string) => void | Promise<void> }) {
    this.client = options.process.client;
    this.tools = new ToolService(options.broker);
    this.dispatcher = new CodexDynamicToolDispatcher({
      resolveThread: (threadId) => this.resolveThread(threadId),
      call: (name, args, context) => this.callTool(name, args, context),
    });
    this.adapter = new CodexAdapter({
      client: this.client,
      resolveBinding: (laneId, generation) => this.byLaneGeneration.get(laneKey(laneId, generation)),
      maxBatchCount: options.broker.config.maxBatchCount,
      maxBatchEncodedBytes: options.broker.config.maxBatchEncodedBytes,
      ...(options.beforeClaim ? { beforeClaim: options.beforeClaim } : {}),
    });
  }

  start(): Promise<string> {
    if (this.startTask) return this.startTask;
    if (this.running) return this.options.process.start();
    this.attach();
    let tracked: Promise<string>;
    tracked = this.options.process.start().then((endpoint) => { this.running = true; return endpoint; }, (error: unknown) => { this.detach(); throw error; }).finally(() => { if (this.startTask === tracked) this.startTask = undefined; });
    this.startTask = tracked; return tracked;
  }
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    if (!this.running && !this.startTask && this.unsubscribers.length === 0) return Promise.resolve();
    let tracked: Promise<void>;
    tracked = this.stopRuntime().finally(() => { if (this.stopTask === tracked) this.stopTask = undefined; });
    this.stopTask = tracked; return tracked;
  }

  registerBinding(registration: CodexBindingRegistration): void {
    const identity = this.options.broker.whoami({ bindingId: registration.bindingId, generation: registration.generation });
    if (identity.adapter !== "codex" || identity.laneAddress !== registration.laneId) throw new Error("Codex thread registration does not match the current broker binding");
    const previousThread = this.byLaneGeneration.get(laneKey(registration.laneId, registration.generation));
    const previousBinding = this.byThread.get(registration.threadId);
    if (previousBinding && (previousBinding.bindingId !== registration.bindingId || previousBinding.generation !== registration.generation)) throw new Error("Codex thread is already registered to another binding");
    const stored = Object.freeze({ ...registration });
    if (previousThread && previousThread.threadId !== registration.threadId) this.byThread.delete(previousThread.threadId);
    this.byThread.set(registration.threadId, stored);
    this.byLaneGeneration.set(laneKey(registration.laneId, registration.generation), stored);
  }

  unregisterBinding(laneId: string, generation: number): void {
    const key = laneKey(laneId, generation);
    const registration = this.byLaneGeneration.get(key);
    if (!registration) return;
    this.byLaneGeneration.delete(key);
    this.byThread.delete(registration.threadId);
  }

  async startBindingThread(input: Omit<CodexBindingRegistration, "threadId"> & { cwd: string; developerInstructions?: string }): Promise<string> {
    const threadId = await this.adapter.startThread({ cwd: input.cwd, ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}) });
    this.registerBinding({ laneId: input.laneId, bindingId: input.bindingId, generation: input.generation, threadId });
    return threadId;
  }

  async resumeBindingThread(registration: CodexBindingRegistration): Promise<string> {
    const threadId = await this.adapter.resumeThread(registration.threadId);
    this.registerBinding({ ...registration, threadId });
    return threadId;
  }

  private resolveThread(threadId: string): ToolBindingContext | undefined {
    const registration = this.byThread.get(threadId);
    if (!registration) return undefined;
    try {
      const current = this.options.broker.whoami({ bindingId: registration.bindingId, generation: registration.generation });
      if (current.adapter !== "codex" || current.laneAddress !== registration.laneId) return undefined;
      return { bindingId: registration.bindingId, generation: registration.generation };
    } catch {
      this.unregisterBinding(registration.laneId, registration.generation);
      return undefined;
    }
  }

  private callTool(name: LaneToolName, args: unknown, context: ToolBindingContext): unknown {
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("Lane tool arguments must be an object");
    return this.tools.call(name, args as Record<string, unknown>, context);
  }

  private notifyReconnect(): void {
    const lanes = new Set([...this.byThread.values()].map((registration) => registration.laneId));
    for (const laneId of lanes) this.options.broker.notifyAdapterAvailable({ operationId: `codex-reconnect:${++this.reconnectSequence}:${laneId}`, adminId: this.options.adminId, laneId });
  }
  private attach(): void {
    if (this.unsubscribers.length) return;
    this.unsubscribers = [
      this.client.onServerRequest((request) => this.dispatcher.dispatch(request.params)),
      this.client.onTransportLoss(() => this.dispatcher.clear()),
      this.options.process.onReconnect(() => this.notifyReconnect()),
    ];
  }
  private detach(): void { for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe(); }
  private async stopRuntime(): Promise<void> {
    await this.startTask?.catch(() => undefined);
    try { if (this.running) await this.options.process.shutdown(); }
    finally { this.running = false; this.detach(); this.byThread.clear(); this.byLaneGeneration.clear(); this.dispatcher.clear(); }
  }
}

export function createCodexRuntime(options: { broker: BrokerService; command: CodexCommand; capabilityCacheDir: string; adminId: string; beforeClaim?: (request: AdapterDeliveryRequest, turnId: string) => void | Promise<void> }): CodexRuntime {
  const process = new CodexAppServerProcess({ command: options.command, gate: new CodexCapabilityGate({ cacheDir: options.capabilityCacheDir }) });
  return new CodexRuntime({ broker: options.broker, process, adminId: options.adminId, ...(options.beforeClaim ? { beforeClaim: options.beforeClaim } : {}) });
}

function laneKey(laneId: string, generation: number): string { return `${laneId}\0${generation}`; }
