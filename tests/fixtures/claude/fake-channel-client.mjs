import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const ChannelNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.object({ message_id: z.string() }).strict(),
  }).strict(),
});

export async function connectFakeClaude(server) {
  const notifications = [];
  const waiters = [];
  const client = new Client(
    { name: "fake-claude-channel", version: "1.0.0" },
    { capabilities: { experimental: { "claude/channel": {} } } },
  );
  client.setNotificationHandler(ChannelNotificationSchema, async (notification) => {
    const waiter = waiters.shift();
    if (waiter) waiter(notification);
    else notifications.push(notification);
  });
  const transport = new StdioClientTransport({ ...server, stderr: "pipe" });
  await client.connect(transport);
  return {
    client,
    transport,
    nextNotification() {
      const queued = notifications.shift();
      return queued ? Promise.resolve(queued) : new Promise((resolve) => waiters.push(resolve));
    },
    async close() { await client.close(); },
  };
}
