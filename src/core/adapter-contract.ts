import type { MessageKind } from "./model.js";

export type AdapterResult =
  | "started_new_turn"
  | "applied_current_turn"
  | "queued_next_turn"
  | "stored_pending"
  | "binding_not_found"
  | "adapter_failed";

export interface AdapterDeliveryRequest {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly targetLaneId: string;
  readonly sequence: number;
  readonly kind: MessageKind;
  readonly bindingGeneration: number;
}

export interface DeliveryAdapter {
  deliver(request: AdapterDeliveryRequest): Promise<AdapterResult>;
}
