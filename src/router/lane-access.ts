import type { RestorePresence } from "./backend.js";
import type { BackendName, CallerContext, ReachSnapshot } from "./types.js";

/** Resolved by the host from the current conversation, never supplied as tool arguments. */
export interface LaneCallerIdentity {
  readonly laneId: string;
  readonly bindingId: string;
  readonly generation: number;
}

/** Facts about this stable ID, including an archived lane whose address has since been reused. */
export interface LaneAccessFacts {
  readonly laneId: string;
  readonly address: string;
  readonly archivedAt: number | null;
  readonly binding: {
    readonly bindingId: string;
    readonly generation: number;
    readonly backend: BackendName;
  } | null;
  readonly reach: ReachSnapshot | null;
}

/** A lane a user could address right now: in service and with a conversation to reopen. */
export interface ActiveLane {
  readonly laneId: string;
  readonly address: string;
  readonly project: string;
  readonly backend: BackendName;
  /**
   * What reopening it would do, not whether a notification would reach it: `online` finds it open,
   * `offline` opens it, `unavailable` cannot open it, for now or for good.
   */
  readonly restorePresence: RestorePresence;
}

/** In-process identity and query access without handing host storage to consumers. */
export interface LaneAccess {
  resolveCaller(context: CallerContext): LaneCallerIdentity;
  /** Recheck immediately before a synchronous write transaction, with no intervening await. */
  assertCurrentCaller(context: CallerContext, expected: LaneCallerIdentity): void;
  /** Null means missing; archivedAt, binding and reach remain independent facts. */
  readLane(laneId: string): LaneAccessFacts | null;
  /** By project, then lane, ignoring case; no role text, conversation or message ever leaves here. */
  listActiveLanes(): readonly ActiveLane[];
}
