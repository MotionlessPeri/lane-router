import type { AdapterDeliveryRequest, AdapterResult, AdapterRuntimeState, AdapterRuntimeStateRequest, DeliveryAdapter } from "../../core/adapter-contract.js";
import { codexDynamicTools } from "./dynamic-tools.js";
import { decodeThreadReadResult, decodeThreadResumeResult, decodeThreadStartResult, decodeTurnStartResult, decodeTurnSteerResult, type ThreadResult } from "./protocol.js";
import { DEFAULT_MAX_BATCH_COUNT, DEFAULT_MAX_BATCH_ENCODED_BYTES, wakeEnvelopeBytes, wakeEnvelopeValue } from "../../core/batch-limits.js";

interface Client { request(method: string, params: unknown): Promise<unknown>; isConnected(): boolean }
interface Binding { readonly threadId: string }

export class CodexAdapter implements DeliveryAdapter {
  constructor(private readonly deps: { client: Client; resolveBinding: (laneId: string, generation: number) => Binding | undefined; beforeClaim?: (request: AdapterDeliveryRequest, turnId: string) => void | Promise<void>; maxBatchCount?: number; maxBatchEncodedBytes?: number }) {}

  async startThread(options: { cwd: string; developerInstructions?: string }): Promise<string> {
    const response = decodeThreadStartResult(await this.deps.client.request("thread/start", { cwd: options.cwd, dynamicTools: codexDynamicTools(), ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}) }));
    return response.thread.id;
  }
  async resumeThread(persistedThreadId: string): Promise<string> {
    const response = decodeThreadResumeResult(await this.deps.client.request("thread/resume", { threadId: persistedThreadId }));
    return response.thread.id;
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
    if (!this.sameBinding(request, binding)) return "binding_changed_retry";
    if (state.availability !== "online") return "stored_pending";
    if (state.turn === "busy" && request.kind === "normal") return "queued_next_turn";
    const wake = wakeEnvelope(request, this.deps.maxBatchCount ?? DEFAULT_MAX_BATCH_COUNT, this.deps.maxBatchEncodedBytes ?? DEFAULT_MAX_BATCH_ENCODED_BYTES);
    try {
      if (state.turn === "busy") {
        const read = decodeThreadReadResult(await this.deps.client.request("thread/read", { threadId: binding.threadId, includeTurns: true }));
        if (!this.sameBinding(request, binding)) return "binding_changed_retry";
        const expectedTurnId = activeTurnId(read);
        decodeTurnSteerResult(await this.deps.client.request("turn/steer", { threadId: binding.threadId, expectedTurnId, input: [{ type: "text", text: wake }] }));
        return "applied_current_turn";
      }
      const response = decodeTurnStartResult(await this.deps.client.request("turn/start", { threadId: binding.threadId, input: [{ type: "text", text: wake }] }));
      await this.deps.beforeClaim?.(request, response.turn.id);
      return "started_new_turn";
    } catch (error) {
      return isMissingThread(error) ? "binding_not_found" : "adapter_failed";
    }
  }

  private sameBinding(request: AdapterDeliveryRequest, expected: Binding): boolean { return this.deps.resolveBinding(request.targetLaneId, request.bindingGeneration)?.threadId === expected.threadId; }

  private async probe(binding: Binding): Promise<AdapterRuntimeState> {
    const response = decodeThreadReadResult(await this.deps.client.request("thread/read", { threadId: binding.threadId, includeTurns: false }));
    if (response.thread.status.type === "idle") return { availability: "online", turn: "idle" };
    if (response.thread.status.type === "active") return { availability: "online", turn: "busy" };
    return { availability: "degraded", turn: "unknown" };
  }
}

function activeTurnId(response: ThreadResult): string {
  for (let index = response.thread.turns.length - 1; index >= 0; index -= 1) { const turn = response.thread.turns[index]; if (turn?.status === "inProgress") return turn.id; }
  throw new Error("Codex thread is busy but has no authoritative in-progress turn");
}
function isMissingThread(error: unknown): boolean { return error instanceof Error && /not found|unknown thread/i.test(error.message); }
function wakeEnvelope(request: AdapterDeliveryRequest, maxBatchCount: number, maxBatchEncodedBytes: number): string {
  const deliveryIds = [...(request.deliveryIds ?? [request.deliveryId])];
  const messageIds = [...(request.messageIds ?? [request.messageId])];
  if (!deliveryIds.length || deliveryIds.length !== messageIds.length || deliveryIds[0] !== request.deliveryId || messageIds[0] !== request.messageId) throw new Error("Codex wake batch IDs are inconsistent");
  if (deliveryIds.length > maxBatchCount) throw new Error("Codex wake batch exceeds maximum count");
  if (wakeEnvelopeBytes(deliveryIds, messageIds) > maxBatchEncodedBytes) throw new Error("Codex wake batch exceeds maximum encoded bytes");
  return wakeEnvelopeValue(deliveryIds, messageIds);
}
