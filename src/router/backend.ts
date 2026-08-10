import type { BackendName, BindingRecord, MessageKind, NotificationOutcome, ReachSnapshot } from "./types.js";

export type { NotificationOutcome, ReachSnapshot, ReachState } from "./types.js";

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
  onAttentionOpportunity(handler: (laneAddress: string) => void): () => void;
  /**
   * Report reachability from state the backend already holds. Deliberately synchronous:
   * lane_directory is the tool consumers call once the link is already broken, so it must never
   * make a platform round trip and must never block.
   */
  reach(binding: BindingRecord): ReachSnapshot;
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

  /** Lookup for query paths that must not fail when a lane names a backend this Router lacks. */
  find(name: BackendName): PlatformBackend | undefined {
    return this.backends.get(name);
  }
}
