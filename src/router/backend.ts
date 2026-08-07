import type { BackendName, BindingRecord, MessageKind } from "./types.js";

export type NotificationOutcome = "delivered" | "deferred" | "offline";

export interface Notification {
  readonly laneAddress: string;
  readonly pendingPath: string;
  readonly kind: MessageKind;
  readonly messageIds: readonly string[];
}

export interface PlatformBackend {
  readonly name: BackendName;
  notifyNormal(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome>;
  notifyCorrection(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome>;
  waitUntilReplaceable(binding: BindingRecord): Promise<void>;
}

export class BackendRegistry {
  private readonly backends = new Map<BackendName, PlatformBackend>();

  constructor(backends: readonly PlatformBackend[]) {
    for (const backend of backends) {
      if (this.backends.has(backend.name)) throw new Error(`Duplicate backend: ${backend.name}`);
      this.backends.set(backend.name, backend);
    }
  }

  require(name: BackendName): PlatformBackend {
    const backend = this.backends.get(name);
    if (!backend) throw new Error(`Backend is not available: ${name}`);
    return backend;
  }
}
