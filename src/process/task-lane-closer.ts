import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RestorePresence } from "../router/backend.js";
import { parseLaneAddress } from "../router/address.js";
import { RouterError } from "../router/router-core.js";
import type { RouterStateStore } from "../router/state-store.js";
import { isTaskLane, TASK_LANE_PREFIX, taskLaneOrigin } from "../router/task-lane.js";
import type { BindingRecord, LaneRecord } from "../router/types.js";
import type { ClaudeChannelHub } from "./local-server.js";

/** How long a closed channel may come back before its finished lane is archived, and a marker waits. */
const GRACE_MS = 30_000;
/** How often finished lanes the channel cannot speak for (Codex, or a Router restarted) are looked at. */
const SWEEP_MS = 60_000;

/**
 * What a close did: ended the process now, will at the end of the running turn, archived a lane that
 * was not open, left a closed lane with unread mail in service, or waits for a window the Router
 * cannot close (a Codex TUI, which its host does not hold).
 */
export type CloseResult =
  | { readonly address: string; readonly action: "closing" | "close_after_turn" | "archived" | "waiting_for_window" }
  | { readonly address: string; readonly action: "unread"; readonly unread: number };

/**
 * The end of a task lane after it said it was done (spec docs/superpowers/specs/2026-10-21-task-lane.md,
 * 4.3 items 3 and 4). The user does not close its window: at the Stop that ends the turn it finished
 * in, this writes `close-requests/<pid>` under the data root, which tells the window to exit cleanly,
 * and then ends that claude.exe. The channel closes, and 30 seconds later, still closed, the lane is
 * archived; a channel that came back in that time was a reconnect, not an end. A sweep archives the
 * finished lanes no channel will ever report on. `close` is the parent's way to end a task lane that
 * never said it was done, or is stuck.
 */
export class TaskLaneCloser {
  private readonly ended = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private sweeping: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribe: Array<() => void>;

  constructor(private readonly options: {
    readonly dataRoot: string;
    readonly state: RouterStateStore;
    readonly hub: Pick<ClaudeChannelHub, "onLifecycle" | "onChannelClosed" | "session">;
    readonly presence: (binding: BindingRecord) => RestorePresence;
    readonly archive: (address: string) => Promise<unknown>;
    readonly kill?: (pid: number) => void;
    readonly now?: () => number;
    readonly onError?: (error: unknown) => void;
  }) {
    this.unsubscribe = [
      options.hub.onLifecycle((report) => { if (report.event === "Stop") this.stopped(report.conversationId, report.joinKey); }),
      options.hub.onChannelClosed((conversationId) => this.channelClosed(conversationId)),
    ];
  }

  /** The first sweep waits out the grace, so channels reconnecting to a restarted Router are seen first. */
  start(): void {
    this.later(() => {
      void this.sweep();
      this.sweeping = setInterval(() => { void this.sweep(); }, SWEEP_MS);
      this.sweeping.unref?.();
    }, GRACE_MS);
  }

  close(): void {
    for (const stop of this.unsubscribe) stop();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    clearInterval(this.sweeping);
  }

  async requestClose(rawAddress: string): Promise<CloseResult> {
    const { address } = parseLaneAddress(rawAddress);
    const state = this.options.state;
    const lane = state.lane(address);
    if (!lane) {
      if (state.archivedLaneAt(address)) throw new RouterError("LANE_ARCHIVED", `Lane is archived: ${address}`);
      throw new RouterError("LANE_NOT_FOUND", `Lane not found: ${address}`);
    }
    if (!isTaskLane(lane.roleDescription)) {
      throw new RouterError("LANE_NOT_A_TASK_LANE", `Lane ${address} is not a task lane: close only ends a lane whose role begins with 「${TASK_LANE_PREFIX}」`);
    }
    // The parent saying it is done: from here on the lane takes no mail and may be archived.
    state.finishLane(lane.id, (this.options.now ?? Date.now)(), taskLaneOrigin(lane.roleDescription));
    const binding = state.activeBindingForLane(address);
    if (binding && this.options.presence(binding) === "online") {
      if (binding.backend !== "claude") return { address, action: "waiting_for_window" };
      const session = this.options.hub.session(binding.conversationId);
      if (session?.turnRunning) return { address, action: "close_after_turn" };
      return this.end(binding, session?.joinKey) ? { address, action: "closing" } : { address, action: "waiting_for_window" };
    }
    try {
      await this.options.archive(address);
      return { address, action: "archived" };
    } catch (error) {
      if (error instanceof RouterError && error.code === "LANE_HAS_PENDING") return { address, action: "unread", unread: state.pendingMessagesByLaneId(lane.id).length };
      throw error;
    }
  }

  /** The finished lanes still in service that are not open are archived; anything refused waits for the next one. */
  async sweep(): Promise<void> {
    for (const lane of this.options.state.finishedLanes()) await this.tryArchive(lane);
  }

  private stopped(conversationId: string, joinKey: string | undefined): void {
    const binding = this.options.state.activeBindingForConversation("claude", conversationId);
    if (!binding) return;
    const lane = this.options.state.lane(binding.laneAddress);
    if (lane?.finishedAt === null || lane === undefined) return;
    this.end(binding, joinKey);
  }

  private channelClosed(conversationId: string): void {
    const binding = this.options.state.activeBindingForConversation("claude", conversationId);
    if (!binding) return;
    const lane = this.options.state.lane(binding.laneAddress);
    if (lane === undefined || lane.finishedAt === null) return;
    this.later(() => { void this.tryArchive(lane); }, GRACE_MS);
  }

  /**
   * The marker first, so the window finds it when its CLI exits; then the process, once per binding.
   * A process already gone is the user having closed the window first, which archiving covers.
   */
  private end(binding: BindingRecord, joinKey: string | undefined): boolean {
    if (this.ended.has(binding.id)) return true;
    const pid = Number(joinKey);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    this.ended.add(binding.id);
    const marker = join(this.options.dataRoot, "close-requests", String(pid));
    try {
      mkdirSync(join(this.options.dataRoot, "close-requests"), { recursive: true });
      writeFileSync(marker, binding.laneAddress, "utf8");
      (this.options.kill ?? ((target: number) => { process.kill(target); }))(pid);
    } catch (error) { this.options.onError?.(error); }
    this.later(() => { rmSync(marker, { force: true }); }, GRACE_MS);
    return true;
  }

  private async tryArchive(lane: LaneRecord): Promise<void> {
    try { await this.options.archive(lane.address); }
    catch (error) {
      // Open, or with unread mail: not yet. Anything else is worth knowing about.
      if (!(error instanceof RouterError && (error.code === "LANE_ONLINE" || error.code === "LANE_HAS_PENDING" || error.code === "LANE_NOT_FOUND"))) this.options.onError?.(error);
    }
  }

  private later(run: () => void, delay: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); run(); }, delay);
    timer.unref?.();
    this.timers.add(timer);
  }
}
