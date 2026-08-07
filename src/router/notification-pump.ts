import type { BackendRegistry, Notification, NotificationOutcome } from "./backend.js";
import type { MailboxStore } from "./mailbox-store.js";
import type { RouterStateStore } from "./state-store.js";
import type { MessageRecord } from "./types.js";

export class NotificationPump {
  constructor(
    private readonly state: RouterStateStore,
    private readonly mailbox: MailboxStore,
    private readonly backends: BackendRegistry,
  ) {}

  async notifyLane(laneAddress: string): Promise<void> {
    const binding = this.state.activeBindingForLane(laneAddress);
    if (!binding) return;
    const messages = this.state.pendingMessages(laneAddress);
    if (messages.length === 0) return;
    const backend = this.backends.require(binding.backend);
    const normal = messages.filter((message) => message.kind === "normal");
    if (normal.length > 0) {
      const notification = this.notification(laneAddress, "normal", normal);
      this.recordOutcome(normal, await backend.notifyNormal(binding, notification));
    }
    for (const correction of messages.filter((message) => message.kind === "correction")) {
      const notification = this.notification(laneAddress, "correction", [correction]);
      this.recordOutcome([correction], await backend.notifyCorrection(binding, notification));
    }
  }

  async onStartup(): Promise<void> {
    for (const laneAddress of this.state.pendingLaneAddresses()) await this.notifyLane(laneAddress);
  }

  async onAttentionOpportunity(laneAddress: string): Promise<void> {
    await this.notifyLane(laneAddress);
  }

  private notification(laneAddress: string, kind: "normal" | "correction", messages: readonly MessageRecord[]): Notification {
    return {
      laneAddress,
      pendingPath: this.mailbox.pendingPath(laneAddress),
      kind,
      messageIds: messages.map((message) => message.id),
    };
  }

  private recordOutcome(messages: readonly MessageRecord[], outcome: NotificationOutcome): void {
    if (outcome === "delivered") this.state.markMessagesNotified(messages.map((message) => message.id));
  }
}
