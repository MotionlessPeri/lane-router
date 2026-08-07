import type { AdapterDeliveryRequest, AdapterResult, AdapterRuntimeState, AdapterRuntimeStateRequest, DeliveryAdapter } from "../../core/adapter-contract.js";
import { codexDynamicTools } from "./dynamic-tools.js";

interface Client { request(method: string, params: unknown): Promise<unknown>; isConnected(): boolean }
interface Binding { readonly threadId: string }

export class CodexAdapter implements DeliveryAdapter {
  constructor(private readonly deps: { client: Client; resolveBinding: (laneId: string, generation: number) => Binding | undefined; beforeClaim?: (request: AdapterDeliveryRequest, turnId: string) => void | Promise<void> }) {}

  async startThread(options: { cwd: string; developerInstructions?: string }): Promise<string> {
    const response = record(await this.deps.client.request("thread/start", { cwd: options.cwd, dynamicTools: codexDynamicTools(), ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}) }));
    return threadId(response);
  }
  async resumeThread(persistedThreadId: string): Promise<string> {
    const response = record(await this.deps.client.request("thread/resume", { threadId: persistedThreadId }));
    return threadId(response);
  }
  async getRuntimeState(request: AdapterRuntimeStateRequest): Promise<AdapterRuntimeState> {
    if (!this.deps.client.isConnected()) return { availability: "offline", turn: "unknown" };
    const binding = this.deps.resolveBinding(request.targetLaneId, request.bindingGeneration);
    if (!binding) return { availability: "degraded", turn: "unknown" };
    try { return await this.probe(binding); }
    catch { return { availability: "degraded", turn: "unknown" }; }
  }
  async deliver(request: AdapterDeliveryRequest): Promise<AdapterResult> {
    const binding = this.deps.resolveBinding(request.targetLaneId, request.bindingGeneration);
    if (!binding) return "binding_not_found";
    if (!this.deps.client.isConnected()) return "stored_pending";
    let state: AdapterRuntimeState;
    try { state = await this.probe(binding); }
    catch (error) { return isMissingThread(error) ? "binding_not_found" : "stored_pending"; }
    if (state.availability !== "online") return "stored_pending";
    if (state.turn === "busy" && request.kind === "normal") return "queued_next_turn";
    const wake = wakeEnvelope(request);
    try {
      if (state.turn === "busy") {
        const read = record(await this.deps.client.request("thread/read", { threadId: binding.threadId, includeTurns: true }));
        const expectedTurnId = activeTurnId(read);
        await this.deps.client.request("turn/steer", { threadId: binding.threadId, expectedTurnId, input: [{ type: "text", text: wake }] });
        return "applied_current_turn";
      }
      const response = record(await this.deps.client.request("turn/start", { threadId: binding.threadId, input: [{ type: "text", text: wake }] }));
      const turn = record(response.turn); if (typeof turn.id !== "string") throw new Error("turn/start response lacks turn.id");
      await this.deps.beforeClaim?.(request, turn.id);
      return "started_new_turn";
    } catch (error) {
      return isMissingThread(error) ? "binding_not_found" : "adapter_failed";
    }
  }

  private async probe(binding: Binding): Promise<AdapterRuntimeState> {
    const response = record(await this.deps.client.request("thread/read", { threadId: binding.threadId, includeTurns: false }));
    const thread = record(response.thread); const status = record(thread.status);
    if (status.type === "idle") return { availability: "online", turn: "idle" };
    if (status.type === "active" || status.type === "busy") return { availability: "online", turn: "busy" };
    return { availability: "degraded", turn: "unknown" };
  }
}

function record(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Codex response must be an object"); return value as Record<string, unknown>; }
function threadId(response: Record<string, unknown>): string { const thread = record(response.thread); if (typeof thread.id !== "string") throw new Error("Codex response lacks thread.id"); return thread.id; }
function activeTurnId(response: Record<string, unknown>): string {
  const thread = record(response.thread);
  if (Array.isArray(thread.turns)) for (let index = thread.turns.length - 1; index >= 0; index -= 1) { const turn = record(thread.turns[index]); if (turn.status === "inProgress" && typeof turn.id === "string") return turn.id; }
  throw new Error("Codex thread is busy but has no authoritative in-progress turn");
}
function isMissingThread(error: unknown): boolean { return error instanceof Error && /not found|unknown thread/i.test(error.message); }
function wakeEnvelope(request: AdapterDeliveryRequest): string {
  const deliveryIds = [...(request.deliveryIds ?? [request.deliveryId])];
  const messageIds = [...(request.messageIds ?? [request.messageId])];
  if (!deliveryIds.length || deliveryIds.length !== messageIds.length || deliveryIds[0] !== request.deliveryId || messageIds[0] !== request.messageId) throw new Error("Codex wake batch IDs are inconsistent");
  return JSON.stringify({ deliveryIds, messageIds });
}
