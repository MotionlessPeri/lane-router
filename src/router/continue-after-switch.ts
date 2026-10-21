import { randomUUID } from "node:crypto";

import type { ReachSnapshot, RestorePresence } from "./backend.js";
import type { ActiveLane } from "./lane-access.js";
import type { BackendName } from "./types.js";
import type { UserMessageDelivery } from "./user-message.js";

/**
 * After the user switches an account by hand, one press asks the lanes of that backend whose turn
 * was cut short to carry on. Switching the account does not wake such a lane, but a letter does. The
 * lifecycle hook reports no reason, and a turn cut off on quota sends no Stop, so "cut short" is read
 * as an open lane whose last lifecycle was UserPromptSubmit. A closed lane had no turn to cut and
 * gets nothing; an open idle one is left alone. A backend that reports no turn state (Codex) cannot
 * be told apart, so there every open lane gets the letter. One that did not stop simply acks it.
 * Spec docs/superpowers/specs/2026-10-21-continue-after-account-switch.md, section 9 (LR-55).
 */
export type ContinueBackend = "claude" | "codex";

export interface ContinueLane {
  readonly laneId: string;
  readonly address: string;
  readonly backend: BackendName;
  readonly restorePresence: RestorePresence;
  readonly reach: ReachSnapshot | null;
}

/** Every lane in service with what its backend says about it now: open or not, and its turn. */
export function continueLanes(lanes: { listActiveLanes(): readonly ActiveLane[]; readLane(laneId: string): { readonly reach: ReachSnapshot | null } | null }): ContinueLane[] {
  return lanes.listActiveLanes().map((lane) => ({
    laneId: lane.laneId, address: lane.address, backend: lane.backend, restorePresence: lane.restorePresence,
    reach: lanes.readLane(lane.laneId)?.reach ?? null,
  }));
}

/** Why a lane gets no letter: closed, or open with no turn left hanging. Undefined: it gets one. */
function withheld(lane: ContinueLane): "offline" | "idle" | undefined {
  if (lane.restorePresence !== "online") return "offline";
  const busy = lane.reach?.believedBusy;
  if (busy === null || busy === undefined) return undefined;
  // Unconfirmed is a channel no lifecycle has reached since it connected: no turn to have been cut.
  return lane.reach?.state === "live" && busy ? undefined : "idle";
}

/**
 * notified: the letter is in the mailbox and the lane was notified; queued: it is in the mailbox of
 * a lane that closed between being chosen and being written to, which reads it when it next opens;
 * skipped: no letter, and why — offline and idle among the reasons.
 */
export interface ContinueResult {
  readonly backend: ContinueBackend;
  readonly notified: readonly string[];
  readonly queued: readonly string[];
  readonly skipped: readonly { readonly address: string; readonly reason: string }[];
}

/** A refusal of the request itself, which both entries answer with 400. */
export class ContinueInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The sender every lane sees: `user:continue-after-switch`, the user acting through this button. */
export const CONTINUE_ORIGIN = "continue-after-switch";

/** A double click, not a second switch: a second press for a backend this soon sends nothing. */
const REPEAT_WINDOW_MS = 60_000;

const BACKEND_NAMES: Record<ContinueBackend, string> = { claude: "Claude", codex: "Codex" };

/** The whole request is one backend; anything more is refused rather than ignored. */
export function parseContinueInput(raw: unknown): ContinueBackend {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ContinueInputError("expected an object naming one backend");
  const unknown = Object.keys(raw).filter((key) => key !== "backend");
  if (unknown.length > 0) throw new ContinueInputError(`continue-after-switch takes only backend; not ${unknown.join(", ")}`);
  const backend = (raw as { backend?: unknown }).backend;
  if (backend !== "claude" && backend !== "codex") throw new ContinueInputError("backend must be claude or codex");
  return backend;
}

/**
 * Fixed words, written by the Router. The first line is what a notification shows as the summary,
 * so it carries the subject; the second says what to do, and what to do if nothing stopped.
 */
export function continueBody(backend: ContinueBackend): string {
  return [
    `切号后继续：用户已手动切换 ${BACKEND_NAMES[backend]} 账号，额度已恢复。`,
    "若你上一回合因额度 / 容量失败而停下，请从中断处继续原任务；若没有停下，忽略本信并 ack。",
  ].join("\n");
}

export class ContinueAfterSwitch {
  private readonly lastRound = new Map<ContinueBackend, number>();
  private readonly now: () => number;
  private readonly newRequestKey: () => string;

  constructor(private readonly dependencies: {
    readonly delivery: UserMessageDelivery;
    readonly lanes: () => readonly ContinueLane[];
    readonly now?: () => number;
    readonly newRequestKey?: () => string;
  }) {
    this.now = dependencies.now ?? Date.now;
    this.newRequestKey = dependencies.newRequestKey ?? randomUUID;
  }

  async continue(backend: ContinueBackend): Promise<ContinueResult> {
    const lanes = this.dependencies.lanes().filter((lane) => lane.backend === backend);
    const now = this.now();
    const last = this.lastRound.get(backend);
    if (last !== undefined && now - last < REPEAT_WINDOW_MS) {
      return { backend, notified: [], queued: [], skipped: lanes.map((lane) => ({ address: lane.address, reason: "sent_within_60s" })) };
    }
    // Taken before any letter goes, so a second press that lands while this one is still sending
    // is the double click it looks like.
    this.lastRound.set(backend, now);
    const notified: string[] = [], queued: string[] = [], skipped: { address: string; reason: string }[] = [];
    const body = continueBody(backend);
    for (const lane of lanes) {
      const reason = withheld(lane);
      if (reason !== undefined) { skipped.push({ address: lane.address, reason }); continue; }
      try {
        // A key of its own per letter: a later press is new mail, not a replay of this one.
        const result = await this.dependencies.delivery.deliverUserMessage({
          target: { laneId: lane.laneId }, source: { kind: "user", origin: CONTINUE_ORIGIN }, body, requestKey: `continue-after-switch:${this.newRequestKey()}`,
        });
        if (result.delivered && result.target.state === "online") notified.push(lane.address);
        else if (result.delivered && result.target.state === "offline") queued.push(lane.address);
        else skipped.push({ address: lane.address, reason: result.target.state });
      } catch {
        // One lane's failure is that lane's: the others still get their letter.
        skipped.push({ address: lane.address, reason: "delivery_failed" });
      }
    }
    return { backend, notified, queued, skipped };
  }
}
