import type { Notification, NotificationOutcome, PlatformBackend } from "../router/backend.js";
import type { BindingRecord } from "../router/types.js";

export type ClaudeChannelOutcome = "started_new_turn" | "queued_next_turn" | "offline" | "failed";

export interface ClaudeChannelPort {
  notify(binding: BindingRecord, notification: Notification): Promise<ClaudeChannelOutcome>;
  waitUntilReplaceable(binding: BindingRecord): Promise<void>;
  onAttentionOpportunity(handler: (binding: BindingRecord) => void): () => void;
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
    return this.notify(binding, notification);
  }

  notifyCorrection(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    return this.notify(binding, notification);
  }

  waitUntilReplaceable(binding: BindingRecord): Promise<void> {
    return this.channel.waitUntilReplaceable(binding);
  }

  onAttentionOpportunity(handler: (laneAddress: string) => void): () => void {
    this.attentionHandlers.add(handler);
    return () => this.attentionHandlers.delete(handler);
  }

  private async notify(binding: BindingRecord, notification: Notification): Promise<NotificationOutcome> {
    const outcome = await this.channel.notify(binding, notification);
    if (outcome === "offline") return "offline";
    if (outcome === "failed") return "deferred";
    return "delivered";
  }
}
