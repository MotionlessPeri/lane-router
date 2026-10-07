import type { Notification, NotificationOutcome, PlatformBackend, ReachSnapshot, RestorePresence } from "../router/backend.js";
import type { BindingRecord, CallerContext, ResolvedIdentity } from "../router/types.js";
import type { ClaudeChannelPort } from "./claude-backend.js";

/**
 * ZCode rides the same channel hub as Claude — one hub, one join semantics — but its bindings are
 * stored under this backend's own name so a (backend, conversation) pair never conflates a ZCode
 * session with a Claude one. Every operation below therefore means exactly what it means on
 * ClaudeBackend; only the name and the words handed to a user differ.
 */
export class ZcodeBackend implements PlatformBackend {
  readonly name = "zcode" as const;
  private readonly attentionHandlers = new Set<(laneAddress: string) => void>();

  constructor(private readonly channel: ClaudeChannelPort) {
    channel.onAttentionOpportunity((binding) => {
      for (const handler of this.attentionHandlers) handler(binding.laneAddress);
    });
  }

  notifyNormal(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    return this.channel.notify(binding, notification);
  }

  notifyCorrection(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    return this.channel.notify(binding, notification);
  }

  waitUntilReplaceable(binding: BindingRecord, signal?: AbortSignal): Promise<void> {
    return this.channel.waitUntilReplaceable(binding, signal);
  }

  onAttentionOpportunity(handler: (laneAddress: string) => void): () => void {
    this.attentionHandlers.add(handler);
    return () => this.attentionHandlers.delete(handler);
  }

  reach(binding: BindingRecord): ReachSnapshot {
    return this.channel.reach(binding.conversationId);
  }

  restorePresence(binding: BindingRecord): RestorePresence {
    return this.channel.reach(binding.conversationId).state === "no_channel" ? "offline" : "online";
  }

  resolveIdentity(context: CallerContext): ResolvedIdentity {
    return this.channel.resolveIdentity(context);
  }

  validateAttach(context: CallerContext): string | undefined {
    const identity = this.resolveIdentity(context);
    if (identity.source !== "joined") return "ZCode conversation identity has not joined its lifecycle channel";
    const reach = this.channel.reach(identity.value);
    if (reach.state !== "live" || reach.believedBusy !== true) return "ZCode conversation lifecycle channel is not live for the current turn";
    return undefined;
  }
}
