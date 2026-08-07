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

  constructor(private readonly options: { broker: BrokerService; process: CodexProcessControl; adminId: string; beforeClaim?: (request: AdapterDeliveryRequest, turnId: string) => void | Promise<void> }) {
    this.client = options.process.client;
    this.tools = new ToolService(options.broker);
    this.dispatcher = new CodexDynamicToolDispatcher({
      resolveThread: (threadId) => this.resolveThread(threadId),
      call: (name, args, context) => this.callTool(name, args, context),
    });
    this.client.onServerRequest((request) => this.dispatcher.dispatch(request.params));
    this.adapter = new CodexAdapter({
      client: this.client,
      resolveBinding: (laneId, generation) => this.byLaneGeneration.get(laneKey(laneId, generation)),
      ...(options.beforeClaim ? { beforeClaim: options.beforeClaim } : {}),
    });
    options.process.onReconnect(() => this.notifyReconnect());
  }

  start(): Promise<string> { return this.options.process.start(); }
  stop(): Promise<void> { return this.options.process.shutdown(); }

  registerBinding(registration: CodexBindingRegistration): void {
    const identity = this.options.broker.whoami({ bindingId: registration.bindingId, generation: registration.generation });
    if (identity.adapter !== "codex" || identity.laneAddress !== registration.laneId) throw new Error("Codex thread registration does not match the current broker binding");
    const previousThread = this.byLaneGeneration.get(laneKey(registration.laneId, registration.generation));
    if (previousThread) this.byThread.delete(previousThread.threadId);
    const previousBinding = this.byThread.get(registration.threadId);
    if (previousBinding && (previousBinding.bindingId !== registration.bindingId || previousBinding.generation !== registration.generation)) throw new Error("Codex thread is already registered to another binding");
    this.byThread.set(registration.threadId, Object.freeze({ ...registration }));
    this.byLaneGeneration.set(laneKey(registration.laneId, registration.generation), Object.freeze({ ...registration }));
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
}

export function createCodexRuntime(options: { broker: BrokerService; command: CodexCommand; capabilityCacheDir: string; adminId: string; beforeClaim?: (request: AdapterDeliveryRequest, turnId: string) => void | Promise<void> }): CodexRuntime {
  const process = new CodexAppServerProcess({ command: options.command, gate: new CodexCapabilityGate({ cacheDir: options.capabilityCacheDir }) });
  return new CodexRuntime({ broker: options.broker, process, adminId: options.adminId, ...(options.beforeClaim ? { beforeClaim: options.beforeClaim } : {}) });
}

function laneKey(laneId: string, generation: number): string { return `${laneId}\0${generation}`; }
