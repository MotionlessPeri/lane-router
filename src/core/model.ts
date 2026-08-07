export type MessageKind = "normal" | "correction";

export type DeliveryStatus =
  | "pending"
  | "notified"
  | "claimed"
  | "acknowledged"
  | "parked";

export interface DeliveryIdentity {
  readonly id: string;
  readonly targetLaneId: string;
  readonly sequence: number;
  readonly kind: MessageKind;
  readonly failureCount: number;
}

export interface PendingDelivery extends DeliveryIdentity {
  readonly status: "pending";
  readonly nextAttemptAt: number | null;
}

export interface NotifiedDelivery extends DeliveryIdentity {
  readonly status: "notified";
  readonly notificationKind: "claim" | "queue";
  readonly deadlineAt: number;
  readonly adapterResult:
    | "started_new_turn"
    | "applied_current_turn"
    | "queued_next_turn";
}

export interface ClaimedDelivery extends DeliveryIdentity {
  readonly status: "claimed";
  readonly claimId: string;
  readonly bindingGeneration: number;
  readonly leaseDeadlineAt: number;
}

export type AckOutcome =
  | Readonly<{ kind: "replied"; replyMessageId: string }>
  | Readonly<{ kind: "recorded"; summary: string; reference?: string }>
  | Readonly<{ kind: "rejected"; reason: string }>;

export interface AcknowledgedDelivery extends DeliveryIdentity {
  readonly status: "acknowledged";
  readonly claimId: string;
  readonly bindingGeneration: number;
  readonly outcome: AckOutcome;
  readonly acknowledgedAt: number;
}

export interface ParkedDelivery extends DeliveryIdentity {
  readonly status: "parked";
  readonly reason: string;
}

export type Delivery =
  | PendingDelivery
  | NotifiedDelivery
  | ClaimedDelivery
  | AcknowledgedDelivery
  | ParkedDelivery;

export interface Binding {
  readonly id: string;
  readonly generation: number;
  readonly adapter: "claude" | "codex";
  readonly conversationId: string;
  readonly status: "bound" | "unbound";
}

export interface BindingConnection {
  readonly bindingId: string;
  readonly generation: number;
  readonly connectedAt: number;
}

export interface EstablishConnectionInput {
  readonly bindingGeneration: number;
  readonly connectedAt: number;
}

export function establishBindingConnection(
  binding: Binding,
  input: EstablishConnectionInput,
): BindingConnection {
  if (binding.status !== "bound") {
    throw new InvalidDeliveryOperationError(
      `Cannot establish a connection for ${binding.status} binding`,
    );
  }
  if (input.bindingGeneration !== binding.generation) {
    throw new StaleBindingGenerationError(
      input.bindingGeneration,
      binding.generation,
    );
  }
  return {
    bindingId: binding.id,
    generation: binding.generation,
    connectedAt: input.connectedAt,
  };
}
import {
  InvalidDeliveryOperationError,
  StaleBindingGenerationError,
} from "./errors.js";
