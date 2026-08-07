export type BackendName = "claude" | "codex";
export type MessageKind = "normal" | "correction";
export type MessageState = "pending" | "resolved";
export type NotificationState = "pending" | "notified";

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
