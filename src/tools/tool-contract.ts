export const LANE_TOOL_NAMES = [
  "lane_directory",
  "lane_attach_current",
  "lane_send",
  "lane_ack",
  "lane_restore_project",
] as const;

export type LaneToolName = (typeof LANE_TOOL_NAMES)[number];

export interface LogicalToolDefinition {
  readonly name: LaneToolName;
  readonly description: string;
  readonly mutating: boolean;
}

const ATTACH_CONFIRMATION = "Before creating, replacing, rotating, or changing the role description of a lane, explain the proposed topology change and obtain the user's explicit confirmation in the conversation. Do not add a confirmation argument.";

export const LANE_TOOLS: readonly LogicalToolDefinition[] = [
  { name: "lane_directory", description: "List the lanes in one project with their role descriptions, current binding, and reachability. Call it when a lane does not respond: `reach` separates a lane with no live channel from one whose channel is open but has never reported a turn, and its timestamps show whether notifications are actually waking the target. This query does not require user confirmation. A lane that has been archived is not listed here, and archiving is permanent: archiving a lane and listing the archived ones are shell commands - `lane-router-lane archive|list-archived`.", mutating: false },
  { name: "lane_attach_current", description: `Attach the current conversation to a lane. Pass model to record which model this role runs on, so every later incarnation of the lane is launched on it; omitting it leaves any existing declaration alone. ${ATTACH_CONFIRMATION}`, mutating: true },
  { name: "lane_send", description: "Write an immutable message to another lane's pending mailbox. Use cc to address the same body to several lanes: each named lane receives its own copy, which it reads and acks independently, and every copy names the whole recipient list. Naming other lanes in the body instead does nothing — the Router never reads it. Use correction with reply_to to amend an earlier message. Returns one record per recipient, whose notificationState says what the delivery actually did.", mutating: true },
  { name: "lane_ack", description: "Resolve one or more pending mailbox messages after the current lane has processed them.", mutating: true },
  { name: "lane_restore_project", description: "Open visible terminal windows that resume existing offline conversations for other lanes in the current lane's project. Call only when the user explicitly asks to reopen lanes. Omit lanes to consider every lane in the project; provide lanes to restore only that subset. A lane in another project is not out of reach, it is just outside this tool: open it from a shell with `lane-router-lane open <project>/<lane>`.", mutating: true },
];

export const LANE_ROUTER_INSTRUCTIONS = `Use lane_directory to inspect roles before proposing a topology change. ${ATTACH_CONFIRMATION} When notified, read the pending mailbox files directly, process related messages together when useful, then call lane_ack with every processed message ID.`;
