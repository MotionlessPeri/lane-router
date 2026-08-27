import { z } from "zod";

import type { LaneToolName } from "./tool-contract.js";

const text = z.string().trim().min(1);

export const toolArgsSchemas = {
  lane_directory: z.object({ project: text }).strict(),
  lane_attach_current: z.object({ address: text, role_description: text.optional(), model: text.optional() }).strict(),
  lane_send: z.object({
    target: text,
    cc: z.array(text).min(1).optional(),
    body: z.string(),
    kind: z.enum(["normal", "correction"]),
    reply_to: text.optional(),
  }).strict(),
  lane_ack: z.object({ message_ids: z.array(text).min(1) }).strict(),
  lane_restore_project: z.object({ lanes: z.array(text).min(1).optional() }).strict(),
} satisfies Record<LaneToolName, z.ZodType>;

export type ToolArgsMap = { [K in LaneToolName]: z.infer<(typeof toolArgsSchemas)[K]> };
