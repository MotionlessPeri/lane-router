export const LANE_TOOL_NAMES = [
  "lane_directory",
  "lane_attach_current",
  "lane_send",
  "lane_ack",
] as const;

export type LaneToolName = (typeof LANE_TOOL_NAMES)[number];

export interface LogicalToolDefinition {
  readonly name: LaneToolName;
  readonly description: string;
  readonly mutating: boolean;
}

const ATTACH_CONFIRMATION = "Before creating, replacing, rotating, or changing the role description of a lane, explain the proposed topology change and obtain the user's explicit confirmation in the conversation. Do not add a confirmation argument.";

export const LANE_TOOLS: readonly LogicalToolDefinition[] = [
  { name: "lane_directory", description: "List the lanes in one project with their role descriptions, current binding, and reachability. Call it when a lane does not respond: `reach` separates a lane with no live channel from one whose channel is open but has never reported a turn, and its timestamps show whether notifications are actually waking the target. This query does not require user confirmation.", mutating: false },
  { name: "lane_attach_current", description: `Attach the current conversation to a lane. ${ATTACH_CONFIRMATION}`, mutating: true },
  { name: "lane_send", description: "Write an immutable message to another lane's pending mailbox. Use correction with reply_to to amend an earlier message.", mutating: true },
  { name: "lane_ack", description: "Resolve one or more pending mailbox messages after the current lane has processed them.", mutating: true },
];

export const LANE_ROUTER_INSTRUCTIONS = `Use lane_directory to inspect roles before proposing a topology change. ${ATTACH_CONFIRMATION} When notified, read the pending mailbox files directly, process related messages together when useful, then call lane_ack with every processed message ID.`;
