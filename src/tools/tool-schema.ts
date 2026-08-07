import { z } from "zod";
import {
  brokerStatusSchema,
  serviceRpcResultSchemas,
} from "../server/rpc-schema.js";
import type { LaneToolName } from "./tool-contract.js";

const text = z.string().trim().min(1);
const operation = { operation_id: text };
const outcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("replied"), replyMessageId: text }).strict(),
  z.object({ kind: z.literal("recorded"), summary: text, documentPath: text.optional(), externalTaskId: text.optional() }).strict(),
  z.object({ kind: z.literal("rejected"), reason: text }).strict(),
]);

export const toolArgsSchemas = {
  lane_whoami: z.object({}).strict(),
  lane_status: z.object({}).strict(),
  lane_send: z.object({ ...operation, target: text, kind: z.enum(["normal", "correction"]), body: z.string(), metadata: z.json(), reply_to: text.nullish() }).strict(),
  lane_inbox_list: z.object({}).strict(),
  lane_message_get: z.object({ message_id: text }).strict(),
  lane_message_claim: z.object({ ...operation, delivery_id: text, claim_id: text.optional() }).strict(),
  lane_message_ack: z.object({ ...operation, delivery_id: text, claim_id: text, outcome }).strict(),
  lane_message_park: z.object({ ...operation, delivery_id: text, reason: text }).strict(),
} satisfies Record<LaneToolName, z.ZodType>;

export const toolResultSchemas = {
  lane_whoami: serviceRpcResultSchemas.whoami,
  lane_status: brokerStatusSchema,
  lane_send: serviceRpcResultSchemas.send,
  lane_inbox_list: serviceRpcResultSchemas.inbox,
  lane_message_get: serviceRpcResultSchemas.message,
  lane_message_claim: serviceRpcResultSchemas.claim,
  lane_message_ack: serviceRpcResultSchemas.ack,
  lane_message_park: serviceRpcResultSchemas.park,
} satisfies Record<LaneToolName, z.ZodType>;

export type ToolArgsMap = { [K in LaneToolName]: z.infer<(typeof toolArgsSchemas)[K]> };
export type ToolResultMap = { [K in LaneToolName]: z.infer<(typeof toolResultSchemas)[K]> };
