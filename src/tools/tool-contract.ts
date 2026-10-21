export const LANE_TOOL_NAMES = [
  "lane_directory",
  "lane_attach_current",
  "lane_send",
  "lane_ack",
  "lane_restore_project",
  "lane_finish",
] as const;

export type LaneToolName = (typeof LANE_TOOL_NAMES)[number];

export interface LogicalToolDefinition {
  readonly name: LaneToolName;
  readonly description: string;
  readonly mutating: boolean;
}

// The gate is these words, not code: the attach path already takes over by default and waits for an
// idle holder. Rotating yourself and taking over someone else attach the same way, so only the agent
// can tell them apart, and an unsure one confirms.
const ATTACH_CONFIRMATION = "Creating a lane, waking or restoring an offline lane, and rotating yourself to a fresh generation of the same lane (keeping its role) do not need the user's confirmation. Before taking over a lane that a different, still-live conversation holds, or before changing an existing lane's role description, explain the change and obtain the user's explicit confirmation in the conversation. If you are unsure whether an attach would rotate your own role or displace someone else's live lane, treat it as a takeover and confirm. Do not add a confirmation argument.";

export const LANE_TOOLS: readonly LogicalToolDefinition[] = [
  { name: "lane_directory", description: "List the lanes in one project with their role descriptions, current binding, and reachability. Call it when a lane does not respond: `reach` separates a lane with no live channel from one whose channel is open but has never reported a turn, and its timestamps show whether notifications are actually waking the target. This query does not require user confirmation. A lane that has been archived is not listed here, and archiving is permanent: archiving a lane and listing the archived ones are shell commands - `lane-router-lane archive|list-archived`.", mutating: false },
  { name: "lane_attach_current", description: `Attach the current conversation to a lane. Pass model to record which model this role runs on, so every later incarnation of the lane is launched on it; omitting it leaves any existing declaration alone. ${ATTACH_CONFIRMATION}`, mutating: true },
  { name: "lane_send", description: "Write an immutable message to another lane's pending mailbox. Use cc to address the same body to several lanes: each named lane receives its own copy, which it reads and acks independently, and every copy names the whole recipient list. Naming other lanes in the body instead does nothing — the Router never reads it. Use correction with reply_to to amend an earlier message. Returns one record per recipient, whose notificationState says what the delivery actually did.", mutating: true },
  { name: "lane_ack", description: "Resolve one or more pending mailbox messages after the current lane has processed them.", mutating: true },
  { name: "lane_restore_project", description: "Open visible terminal windows that resume existing offline conversations for other lanes in the current lane's project. Call when you need to reach offline peer lanes for the current task; wake only the lanes you actually need, not speculatively in bulk. Omit lanes to consider every lane in the project; provide lanes to restore only that subset. A lane in another project is not out of reach, it is just outside this tool: open it from a shell with `lane-router-lane open <project>/<lane>`.", mutating: true },
  // No address: a lane finishes itself and nothing else, and a role lane cannot finish at all, since
  // what follows is archiving, which is permanent.
  { name: "lane_finish", description: "Finish the current task lane. Only a lane whose role description begins with 「任务 lane：」 can call it. First deliver the work, report it in the issue the lane was opened for, read and lane_ack every message, and answer or close the lane's own 问答 issues; the call is refused while anything is left and says what. Once it succeeds the lane takes no more mail, and when this turn ends the Router closes its window and archives it. Call no more tools after it and end the turn.", mutating: true },
];

export const LANE_ROUTER_INSTRUCTIONS = `Use lane_directory to inspect roles before proposing a topology change. ${ATTACH_CONFIRMATION} When notified, read the pending mailbox files directly, process related messages together when useful, then call lane_ack with every processed message ID.`;
