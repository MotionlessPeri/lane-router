import type { AdapterDeliveryRequest, AdapterResult, AdapterRuntimeState, AdapterRuntimeStateRequest, DeliveryAdapter } from "../../core/adapter-contract.js";
import type { ClaudeChannelRegistry } from "./channel-bridge.js";

interface ClaudeBinding { readonly bindingId: string }

export class ClaudeAdapter implements DeliveryAdapter {
  constructor(private readonly options: { resolveBinding: (laneId: string, generation: number) => ClaudeBinding | undefined; channels: Pick<ClaudeChannelRegistry, "getRuntimeState" | "deliver"> }) {}

  async getRuntimeState(request: AdapterRuntimeStateRequest): Promise<AdapterRuntimeState> {
    const binding = this.options.resolveBinding(request.targetLaneId, request.bindingGeneration);
    return binding ? this.options.channels.getRuntimeState(binding.bindingId, request.bindingGeneration) : { availability: "degraded", turn: "unknown" };
  }

  async deliver(request: AdapterDeliveryRequest): Promise<AdapterResult> {
    const binding = this.options.resolveBinding(request.targetLaneId, request.bindingGeneration);
    if (!binding) return "binding_not_found";
    await Promise.resolve(this.options.channels.getRuntimeState(binding.bindingId, request.bindingGeneration));
    if (this.options.resolveBinding(request.targetLaneId, request.bindingGeneration)?.bindingId !== binding.bindingId) return "binding_changed_retry";
    return this.options.channels.deliver(binding.bindingId, request.bindingGeneration, request);
  }
}
