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
      messages: messages.map((message) => ({
        id: message.id,
        // Free: the pump is already holding the records. The summary below is not — it costs a
        // file read, which is why only one of the two needed weighing.
        sender: message.senderLane,
        summary: this.summary(message),
      })),
    };
  }

  /**
   * Reading a body is the only part of building a notification that touches the filesystem, so it
   * is the only part that can fail on its own. A message whose file is missing or corrupt loses
   * its own summary and nothing else: letting that failure escape would leave the lane unwoken,
   * which is a worse fault than the one summaries were added to fix. Corruption is therefore not
   * reported here — the read paths that must not paper over it still raise it.
   */
  private summary(message: MessageRecord): string {
    try { return summarize(this.mailbox.readBody(message.relativePath)); }
    catch { return ""; }
  }

  // Every outcome is recorded, including the ones that delivered nothing. Leaving those at
  // 'pending' was what made "never attempted" and "attempted, nobody home" look identical.
  // This is observational only: notifyLane still selects by message state, so the recorded
  // outcome never changes when a notification is sent.
  private recordOutcome(messages: readonly MessageRecord[], outcome: NotificationOutcome): void {
    this.state.recordNotificationOutcome(messages.map((message) => message.id), outcome);
  }
}

/** A budget, not a contract: the summary shares one CLI line with the rest of the payload. */
const SUMMARY_LIMIT = 80;

/**
 * The summary is the first non-empty line of the body, cut to one line's worth. Senders already
 * put the subject on the first line, so this reads a convention that is in use rather than asking
 * anyone to follow a new one; and triage only needs to know roughly what the message is about, so
 * anything cleverer here would buy less than it costs in predictability.
 */
function summarize(body: string): string {
  const line = body.split("\n").map((value) => value.trim()).find((value) => value.length > 0);
  if (line === undefined) return "";
  // By code point, not code unit: cutting a surrogate pair in half would put a broken character
  // in the one line a receiver reads.
  const characters = [...line];
  return characters.length <= SUMMARY_LIMIT ? line : `${characters.slice(0, SUMMARY_LIMIT - 1).join("")}…`;
}
