export const LANE_TOOL_NAMES = [
  "lane_whoami",
  "lane_status",
  "lane_send",
  "lane_inbox_list",
  "lane_message_get",
  "lane_message_claim",
  "lane_message_ack",
  "lane_message_park",
] as const;
export type LaneToolName = (typeof LANE_TOOL_NAMES)[number];
export interface ToolBindingContext {
  readonly bindingId: string;
  readonly generation: number;
}
export interface LogicalToolDefinition {
  readonly name: LaneToolName;
  readonly description: string;
  readonly mutating: boolean;
}
export const LANE_TOOLS: readonly LogicalToolDefinition[] = LANE_TOOL_NAMES.map(
  (name) => ({
    name,
    description: `Lane Router logical operation ${name}`,
    mutating: [
      "lane_send",
      "lane_message_claim",
      "lane_message_ack",
      "lane_message_park",
    ].includes(name),
  }),
);
