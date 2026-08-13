import type { BackendName, BindingRecord, CallerContext, MessageKind, NotificationOutcome, ReachSnapshot, ResolvedIdentity } from "./types.js";

export type { NotificationOutcome, ReachSnapshot, ReachState, ResolvedIdentity } from "./types.js";
export type RestorePresence = "online" | "offline" | "unavailable";

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
  /**
   * Wait until the current binding can be replaced. `signal` ends the wait: without it the wait
   * outlived the caller, so an attach that had already been reported as failed could still
   * replace the binding minutes later, with nobody listening. Measured twice on 2026-08-10/12.
   */
  waitUntilReplaceable(binding: BindingRecord, signal?: AbortSignal): Promise<void>;
  onAttentionOpportunity(handler: (laneAddress: string) => void): () => void;
  /**
   * Report reachability from state the backend already holds. Deliberately synchronous:
   * lane_directory is the tool consumers call once the link is already broken, so it must never
   * make a platform round trip and must never block.
   */
  reach(binding: BindingRecord): ReachSnapshot;
  /** Whether an interactive client already owns this conversation for restore decisions. */
  restorePresence(binding: BindingRecord): RestorePresence;
  /**
   * Turn what a caller claims about itself into the identity a binding is stored under. It must
   * be stable across restarts of the calling process, or a lane stops recognising the
   * conversation it belongs to and has to be attached again after every restart.
   */
  resolveIdentity(context: CallerContext): ResolvedIdentity;
  /** Return a user-facing reason when this caller cannot safely attach yet. */
  validateAttach?(context: CallerContext): string | undefined;
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
