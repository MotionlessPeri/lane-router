export type DeliveryOperation =
  | "acknowledge_delivery"
  | "apply_adapter_result"
  | "claim_delivery"
  | "defer_delivery"
  | "establish_binding_connection"
  | "expire_claim"
  | "expire_notification"
  | "mark_binding_unbound"
  | "park_delivery"
  | "rebuild_binding"
  | "record_started_turn_ended_before_claim"
  | "renew_claim"
  | "unpark_delivery";

export class DeliveryStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class IllegalDeliveryTransitionError extends DeliveryStateError {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal delivery transition: ${from} -> ${to}`);
  }
}

export class InvalidDeliveryOperationError extends DeliveryStateError {
  readonly provided?: unknown;
  readonly current?: unknown;

  constructor(
    readonly operation: DeliveryOperation,
    message: string,
    context?: Readonly<{ provided?: unknown; current?: unknown }>,
  ) {
    super(message);
    this.provided = context?.provided;
    this.current = context?.current;
  }
}

export class DeadlineNotExpiredError extends DeliveryStateError {
  constructor(
    readonly operation: DeliveryOperation,
    readonly provided: number,
    readonly current: number,
  ) {
    super(
      `Cannot ${operation}: time ${provided} is before deadline ${current}`,
    );
  }
}

export class StaleBindingGenerationError extends DeliveryStateError {
  constructor(
    readonly operation: DeliveryOperation,
    readonly provided: number,
    readonly current: number,
  ) {
    super(`Binding generation ${provided} is stale; current generation is ${current}`);
  }
}

export class ClaimMismatchError extends DeliveryStateError {
  constructor(
    readonly operation: DeliveryOperation,
    readonly provided: string,
    readonly current: string,
  ) {
    super(`Claim ${provided} is not current; expected ${current}`);
  }
}

export class ClaimExpiredError extends DeliveryStateError {
  constructor(
    readonly operation: DeliveryOperation,
    readonly provided: number,
    readonly current: number,
  ) {
    super(`Cannot ${operation}: claim expired at ${current}`);
  }
}
