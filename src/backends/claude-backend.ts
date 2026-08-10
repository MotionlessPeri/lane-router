import type { Notification, NotificationOutcome, PlatformBackend, ReachSnapshot } from "../router/backend.js";
import type { BindingRecord } from "../router/types.js";

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
}
