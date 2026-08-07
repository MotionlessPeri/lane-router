export class DeliveryStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class IllegalDeliveryTransitionError extends DeliveryStateError {
  constructor(from: string, to: string) {
    super(`Illegal delivery transition: ${from} -> ${to}`);
  }
}

export class InvalidDeliveryOperationError extends DeliveryStateError {}

export class DeadlineNotExpiredError extends DeliveryStateError {}

export class StaleBindingGenerationError extends DeliveryStateError {
  constructor(provided: number, current: number) {
    super(`Binding generation ${provided} is stale; current generation is ${current}`);
  }
}

export class ClaimMismatchError extends DeliveryStateError {}

export class ClaimExpiredError extends DeliveryStateError {}
