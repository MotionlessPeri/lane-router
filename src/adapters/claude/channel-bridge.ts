export interface ClaudeChannelNotification {
  readonly method: "notifications/claude/channel";
  readonly params: {
    readonly content: string;
    readonly meta: Readonly<{ message_id: string }>;
  };
}

export interface ClaudeChannelSink {
  notification(value: ClaudeChannelNotification): Promise<void>;
}
