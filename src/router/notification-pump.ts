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

  // Every outcome is recorded, including the ones that delivered nothing. Leaving those at
  // 'pending' was what made "never attempted" and "attempted, nobody home" look identical.
  // This is observational only: notifyLane still selects by message state, so the recorded
  // outcome never changes when a notification is sent.
  private recordOutcome(messages: readonly MessageRecord[], outcome: NotificationOutcome): void {
    this.state.recordNotificationOutcome(messages.map((message) => message.id), outcome);
  }
}
