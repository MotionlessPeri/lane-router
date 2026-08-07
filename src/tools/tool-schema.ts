import { z } from "zod";

import type { LaneToolName } from "./tool-contract.js";

const text = z.string().trim().min(1);

export const toolArgsSchemas = {
  lane_directory: z.object({ project: text }).strict(),
  lane_attach_current: z.object({ address: text, role_description: text.optional() }).strict(),
  lane_send: z.object({
    target: text,
    body: z.string(),
    kind: z.enum(["normal", "correction"]),
    reply_to: text.optional(),
  }).strict(),
  lane_ack: z.object({ message_ids: z.array(text).min(1) }).strict(),
} satisfies Record<LaneToolName, z.ZodType>;

export type ToolArgsMap = { [K in LaneToolName]: z.infer<(typeof toolArgsSchemas)[K]> };
