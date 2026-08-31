import type { Notification } from "./backend.js";

/**
 * The single place a notification payload is built. Both backends call it because this is the
 * string a receiving agent actually reads, and it used to be assembled twice — once for Claude in
 * the client process, once for Codex in the Router. The two field sets happened to agree; nothing
 * kept them agreeing, and adding a field is exactly the change that pulls them apart.
 *
 * The four fields that were here before summaries existed keep their names, values and position:
 * receivers are agents that have been reading this shape, so appending is safe where renaming and
 * reordering are not.
 */
export function notificationPayload(notification: Notification): string {
  return JSON.stringify({
    kind: "lane_router_mailbox",
    laneAddress: notification.laneAddress,
    pendingPath: notification.pendingPath,
    messageIds: [...notification.messageIds],
    // The envelope `kind` above is a constant, so it never said whether this was a correction.
    // Without this field a correction — the one kind of mail that says an earlier message was
    // wrong — looks exactly like routine mail until the file is opened.
    messageKind: notification.kind,
    messages: notification.messages.map((message) => ({
      id: message.id,
      sender: message.sender,
      summary: message.summary,
    })),
  });
}
