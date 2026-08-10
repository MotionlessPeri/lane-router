export type BackendName = "claude" | "codex";
export type MessageKind = "normal" | "correction";
export type MessageState = "pending" | "resolved";

/**
 * What a notification attempt actually achieved. The Router never claims the receiver saw
 * anything: on the Claude side it can only observe that a frame left the process, so there is
 * no `delivered`. Whether a notification produced a turn is answered by comparing
 * `ReachSnapshot.lastNotifiedAt` with `lastLifecycleAt`, which rests on observed evidence.
 */
export type NotificationOutcome = "sent" | "deferred" | "no_channel" | "send_failed";
export type NotificationState = "pending" | NotificationOutcome;

/** Whether the Router can still reach a lane's bound conversation, and what that claim rests on. */
export type ReachState = "live" | "unconfirmed" | "no_channel";

export interface ReachSnapshot {
  readonly state: ReachState;
  readonly connectedAt: number | null;
  readonly lastLifecycleAt: number | null;
  readonly lastNotifiedAt: number | null;
  /** The Router's belief, not an observation; null when a backend keeps no such belief. */
  readonly believedBusy: boolean | null;
}

export interface LaneRecord {
  readonly address: string;
  readonly project: string;
  readonly roleDescription: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BindingRecord {
  readonly id: string;
  readonly laneAddress: string;
  readonly backend: BackendName;
  readonly conversationId: string;
  readonly generation: number;
  readonly startup: Readonly<Record<string, unknown>>;
  readonly activeAt: number;
  readonly inactiveAt: number | null;
}

export interface MessageRecord {
  readonly id: string;
  readonly requestKey: string;
  readonly senderLane: string;
  readonly targetLane: string;
  readonly kind: MessageKind;
  readonly replyTo: string | null;
  readonly relativePath: string;
  readonly contentSha256: string;
  readonly state: MessageState;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
  readonly ackLane: string | null;
  readonly ackGeneration: number | null;
  readonly notificationState: NotificationState;
}

export interface NewMessageRecord {
  readonly id: string;
  readonly requestKey: string;
  readonly senderLane: string;
  readonly targetLane: string;
  readonly kind: MessageKind;
  readonly replyTo: string | null;
  readonly relativePath: string;
  readonly contentSha256: string;
  readonly createdAt: number;
}

export interface CallerContext {
  readonly backend: BackendName;
  readonly conversationId: string;
  readonly requestKey: string;
}
