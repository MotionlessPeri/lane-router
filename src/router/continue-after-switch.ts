import { randomUUID } from "node:crypto";

import type { BackendName } from "./types.js";
import type { UserMessageDelivery } from "./user-message.js";

/**
 * After the user switches an account by hand, one press asks every lane of that backend to carry
 * on. A turn that failed on quota or capacity has already ended, and the lane sits idle; switching
 * the account does not wake it, but a letter does. Which lanes actually failed is not knowable here
 * (the lifecycle hook reports no reason), so every lane of the backend gets the letter, and one that
 * did not stop simply acks it. Spec docs/superpowers/specs/2026-10-21-continue-after-account-switch.md.
 */
export type ContinueBackend = "claude" | "codex";

export interface ContinueLane {
  readonly laneId: string;
  readonly address: string;
  readonly backend: BackendName;
}

/**
 * notified: the letter is in the mailbox and the lane was notified; queued: it is in the mailbox of
 * a lane that is not open, which reads it when it next is; skipped: no letter, and why.
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
