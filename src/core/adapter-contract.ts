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
  /** Ordered batch represented by this wake; the first ID equals deliveryId. */
  readonly deliveryIds?: readonly string[];
  readonly messageId: string;
  /** Ordered message IDs in the same batch; the first ID equals messageId. */
  readonly messageIds?: readonly string[];
  readonly targetLaneId: string;
  readonly sequence: number;
  readonly kind: MessageKind;
  readonly bindingGeneration: number;
}

export interface DeliveryAdapter {
  deliver(request: AdapterDeliveryRequest): Promise<AdapterResult>;
}
