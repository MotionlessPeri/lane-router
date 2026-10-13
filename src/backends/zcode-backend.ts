import type { Notification, NotificationOutcome, PlatformBackend, ReachSnapshot, RestorePresence } from "../router/backend.js";
import { notificationPayload } from "../router/notification-payload.js";
import type { BindingRecord, CallerContext, ResolvedIdentity } from "../router/types.js";
import type { ClaudeChannelPort } from "./claude-backend.js";

/**
 * The slice of the headless driver a binding's delivery path needs. Kept structural so the backend
 * never depends on process spawning: its tests (and any future host) can supply a plain object.
 */
export interface ZcodeDriverSessionPort {
  hasSession(sessionId: string): boolean;
  /** `content` is the lane notification payload; a send is the turn that delivers it. */
  send(sessionId: string, content: string): Promise<NotificationOutcome>;
  waitUntilIdle(sessionId: string, signal?: AbortSignal): Promise<void>;
  sessionSnapshot(sessionId: string): { readonly busy: boolean; readonly createdAt: number; readonly lastLifecycleAt: number | null; readonly lastNotifiedAt: number | null } | undefined;
  onTurnSettled(handler: (sessionId: string) => void): () => void;
}

/**
 * ZCode rides the same channel hub as Claude — one hub, one join semantics — but its bindings are
 * stored under this backend's own name so a (backend, conversation) pair never conflates a ZCode
 * session with a Claude one. A binding whose conversationId the headless driver owns never touches
 * the channel: its notification *is* a `session/send` turn, its reach is the driver's busy/idle
 * truth, and its attach needs no join because the Router itself created the session. Everything
 * else keeps exactly the channel semantics the interactive sessions have always had.
 */
export class ZcodeBackend implements PlatformBackend {
  readonly name = "zcode" as const;
  private readonly attentionHandlers = new Set<(laneAddress: string) => void>();

  constructor(
    private readonly channel: ClaudeChannelPort,
    private readonly driver: ZcodeDriverSessionPort | undefined = undefined,
    private readonly resolveLane: (sessionId: string) => string | undefined = () => undefined,
  ) {
    channel.onAttentionOpportunity((binding) => {
      for (const handler of this.attentionHandlers) handler(binding.laneAddress);
    });
    // A settled turn is the headless counterpart of a Stop lifecycle report: the session exists,
    // it just finished working, and deferred mail deserves its delivery now.
    driver?.onTurnSettled((sessionId) => {
      const lane = this.resolveLane(sessionId);
      if (lane !== undefined) for (const handler of this.attentionHandlers) handler(lane);
    });
  }

  notifyNormal(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    if (this.driven(binding)) return this.driver!.send(binding.conversationId, notificationPayload(notification));
    return this.channel.notify(binding, notification);
  }

  notifyCorrection(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    // The payload itself carries messageKind, so a correction reaches a headless turn already
    // marked as one — the same single source of truth every other backend reads.
    if (this.driven(binding)) return this.driver!.send(binding.conversationId, notificationPayload(notification));
    return this.channel.notify(binding, notification);
  }

  waitUntilReplaceable(binding: BindingRecord, signal?: AbortSignal): Promise<void> {
    if (this.driven(binding)) return this.driver!.waitUntilIdle(binding.conversationId, signal);
    return this.channel.waitUntilReplaceable(binding, signal);
  }

  onAttentionOpportunity(handler: (laneAddress: string) => void): () => void {
    this.attentionHandlers.add(handler);
    return () => this.attentionHandlers.delete(handler);
  }

  reach(binding: BindingRecord): ReachSnapshot {
    if (this.driven(binding)) {
      const snapshot = this.driver!.sessionSnapshot(binding.conversationId)!;
      return {
        state: snapshot.lastLifecycleAt === null ? "unconfirmed" : "live",
        connectedAt: snapshot.createdAt,
        lastLifecycleAt: snapshot.lastLifecycleAt,
        lastNotifiedAt: snapshot.lastNotifiedAt,
        believedBusy: snapshot.busy,
      };
    }
    return this.channel.reach(binding.conversationId);
  }

  restorePresence(binding: BindingRecord): RestorePresence {
    // A driven session lives inside the Router process: there is no separate client a restorer
    // could duplicate, so it counts as occupied by definition.
    if (this.driven(binding)) return "online";
    return this.channel.reach(binding.conversationId).state === "no_channel" ? "offline" : "online";
  }

  resolveIdentity(context: CallerContext): ResolvedIdentity {
    if (this.driver?.hasSession(context.conversationId)) return { value: context.conversationId, source: "caller" };
    return this.channel.resolveIdentity(context);
  }

  validateAttach(context: CallerContext): string | undefined {
    // The Router created and holds this session; its existence is the whole precondition the
    // channel join exists to establish for interactive sessions.
    if (this.driver?.hasSession(context.conversationId)) return undefined;
    const identity = this.resolveIdentity(context);
    if (identity.source !== "joined") return "ZCode conversation identity has not joined its lifecycle channel";
    const reach = this.channel.reach(identity.value);
    if (reach.state !== "live" || reach.believedBusy !== true) return "ZCode conversation lifecycle channel is not live for the current turn";
    return undefined;
  }

  private driven(binding: BindingRecord): boolean {
    return this.driver !== undefined && this.driver.hasSession(binding.conversationId);
  }
}
