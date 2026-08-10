import type { Notification, NotificationOutcome, PlatformBackend, ReachSnapshot } from "../router/backend.js";
import type { BindingRecord, CallerContext, ResolvedIdentity } from "../router/types.js";

/**
 * What the Claude channel can actually establish. There is deliberately no value meaning
 * "the receiver saw it": the hub writes a frame into a socket and learns nothing more.
 */
export type ClaudeChannelOutcome = "sent" | "no_channel" | "send_failed";

export interface ClaudeChannelPort {
  notify(binding: BindingRecord, notification: Notification): Promise<ClaudeChannelOutcome>;
  waitUntilReplaceable(binding: BindingRecord): Promise<void>;
  onAttentionOpportunity(handler: (binding: BindingRecord) => void): () => void;
  reach(conversationId: string): ReachSnapshot;
  resolveIdentity(context: { conversationId: string; joinKey?: string }): ResolvedIdentity;
}

export class ClaudeBackend implements PlatformBackend {
  readonly name = "claude" as const;
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

  waitUntilReplaceable(binding: BindingRecord): Promise<void> {
    return this.channel.waitUntilReplaceable(binding);
  }

  onAttentionOpportunity(handler: (laneAddress: string) => void): () => void {
    this.attentionHandlers.add(handler);
    return () => this.attentionHandlers.delete(handler);
  }

  reach(binding: BindingRecord): ReachSnapshot {
    return this.channel.reach(binding.conversationId);
  }

  resolveIdentity(context: CallerContext): ResolvedIdentity {
    return this.channel.resolveIdentity(context);
  }

  validateAttach(context: CallerContext): string | undefined {
    const identity = this.resolveIdentity(context);
    if (identity.source !== "joined") return "Claude conversation identity has not joined its lifecycle channel";
    const reach = this.channel.reach(identity.value);
    if (reach.state !== "live" || reach.believedBusy !== true) return "Claude conversation lifecycle channel is not live for the current turn";
    return undefined;
  }
}
