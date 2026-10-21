import type { BackendName } from "../../router/types.js";

export type IssueOrigin = "answer" | "question";
export type IssueStatus = "open" | "closed";
export type QuestionStatus = "waiting_user" | "waiting_lane" | "answered" | "not_needed";
export type EntryKind = "question" | "answer" | "reply" | "event";
export type EntrySource = "agent" | "user_page" | "agent_reported_tui_user";
export type AttentionReason = "waiting_user" | "unread_lane_content";

export class IssueError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "INVALID_REFERENCE" | "ISSUE_NOT_FOUND" | "ISSUE_CLOSED" | "LANE_UNAVAILABLE" | "OPERATION_CONFLICT" | "QUESTIONS_WAITING" | "ATTACHMENT_TOO_LARGE", message: string) {
    super(message);
    this.name = "IssueError";
  }
}

export interface IssueThread {
  readonly id: string;
  readonly ownerLaneId: string;
  readonly title: string;
  readonly originKind: IssueOrigin;
  readonly status: IssueStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
  /** Who ended it; set exactly when the issue is closed. */
  readonly closedBy: IssueCloser | null;
  readonly readSeq: number;
  readonly nextSeq: number;
}
export type IssueCloser = "user" | "lane";

export interface IssueEntry {
  readonly id: string;
  readonly issueId: string;
  readonly seq: number;
  readonly kind: EntryKind;
  readonly author: "lane" | "user";
  readonly source: EntrySource;
  readonly body: string;
  readonly relatedEntryId: string | null;
  readonly recordedByBindingId: string | null;
  readonly recordedByGeneration: number | null;
  readonly createdAt: number;
}

export interface IssueQuestion {
  readonly id: string;
  readonly issueId: string;
  readonly promptEntryId: string;
  /** Initial recipient; subsequent turns change status, never this provenance. */
  readonly askedTo: "user" | "lane";
  readonly status: QuestionStatus;
  readonly answerEntryId: string | null;
  readonly reason: string | null;
}

export interface IssueDelivery {
  readonly id: string;
  readonly issueId: string;
  readonly entryId: string;
  readonly ownerLaneId: string;
  readonly body: string;
  readonly sourceKind: "user";
  readonly sourceOrigin: "issues";
  readonly requestKey: string;
  readonly handoffState: "pending" | "accepted" | "blocked";
  readonly coreMessageId: string | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  readonly lastTargetState: string | null;
  readonly processedAt: number | null;
  readonly processedByBindingId: string | null;
  readonly processedByGeneration: number | null;
  readonly createdAt: number;
}

/** Only the four image types a page may show inline are ever named; everything else is opaque bytes. */
export type AttachmentMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/octet-stream";
/** A file the user sent; its issue and entry are set together once a reply or new issue takes it. */
export interface IssueAttachment {
  readonly id: string;
  readonly issueId: string | null;
  readonly entryId: string | null;
  readonly fileName: string;
  readonly mediaType: AttachmentMediaType;
  readonly size: number;
  readonly sha256: string;
  readonly storedPath: string;
  readonly createdAt: number;
}
/** What an upload answers with. */
export interface AttachmentUpload {
  readonly attachmentId: string;
  readonly fileName: string;
  readonly size: number;
  readonly mediaType: AttachmentMediaType;
}

export interface IssueOperation {
  readonly actorScope: string;
  readonly operation: string;
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly resultJson: string;
  readonly createdAt: number;
}

export interface IssueCursor { readonly updatedAt: number; readonly id: string }
export type IssueFilter = "attention" | "open" | "closed" | "all";
export interface IssueListQuery {
  readonly filter?: IssueFilter;
  readonly before?: IssueCursor;
  readonly limit?: number;
  /** Only issues whose lane belongs to this project; the page's alone, not a lane tool's. */
  readonly project?: string;
}
/** Per project with at least one issue: how many the filter lists, and how many need the user. */
export interface IssueProjectCount {
  /** Null gathers the issues of lanes that no longer exist. */
  readonly project: string | null;
  readonly count: number;
  readonly attentionCount: number;
}
export interface IssueProjects { readonly items: readonly IssueProjectCount[] }
/** A reference in some text that names exactly one issue: as written, and what it names. */
export interface IssueRef {
  readonly ref: string;
  readonly id: string;
  readonly title: string;
  readonly status: IssueStatus;
  /** Null when the lane no longer exists. */
  readonly ownerAddress: string | null;
}
export interface IssueRefs { readonly items: readonly IssueRef[] }
export interface IssueHistoryQuery { readonly afterSeq?: number; readonly limit?: number }
export interface IssueOwner {
  readonly laneId: string;
  readonly address: string | null;
  /** Null when the lane no longer exists; an archived lane keeps its project. */
  readonly project: string | null;
  readonly state: "active" | "archived" | "missing";
  /** The Router's belief about reaching the lane, not whether it is handling anything; null unless active. */
  readonly presence: IssuePresence | null;
}
export type IssuePresence = "online" | "busy" | "unconfirmed" | "offline";
export interface IssueSummary extends IssueThread {
  readonly owner: IssueOwner;
  readonly waitingUserCount: number;
  readonly waitingLaneCount: number;
  readonly attentionReasons: readonly AttentionReason[];
}
export interface IssueList { readonly items: readonly IssueSummary[]; readonly nextCursor: IssueCursor | null }
/** What a reader is told about a file an entry carries; the page opens other files by their saved path. */
export interface IssueAttachmentInfo {
  readonly id: string;
  readonly fileName: string;
  readonly size: number;
  readonly mediaType: AttachmentMediaType;
  readonly storedPath: string;
}
/** An entry as read, with the files it carries when it carries any. */
export type IssueEntryView = IssueEntry & { readonly attachments?: readonly IssueAttachmentInfo[] };
export interface IssueDetail {
  readonly thread: IssueThread;
  readonly owner: IssueOwner;
  readonly entries: readonly IssueEntryView[];
  readonly questions: readonly IssueQuestion[];
  readonly deliveries: readonly IssueDelivery[];
  readonly displayedThroughSeq: number;
  readonly hasMore: boolean;
}

export type PublishIssueInput = { readonly operationKey: string; readonly title: string } & (
  | { readonly kind: "answer"; readonly originalQuestion: string; readonly body: string }
  | { readonly kind: "question"; readonly body: string }
);
export interface AppendIssueInput {
  readonly operationKey: string;
  readonly issueId: string;
  readonly kind: "answer" | "explanation" | "question" | "tui_user";
  readonly body: string;
  readonly questionId?: string;
}
export type UpdateIssueQuestionInput = { readonly operationKey: string; readonly issueId: string; readonly questionId: string } & (
  | { readonly status: "answered"; readonly answerEntryId: string }
  | { readonly status: "not_needed"; readonly reason: string }
);
/** The user's own opening of a topic with one lane; the lane is named by its stable ID. */
export interface CreateIssueInput {
  readonly operationKey: string;
  readonly laneId: string;
  readonly title: string;
  /** May be blank when files are sent. */
  readonly body: string;
  /** Uploads this entry takes; at most ten. */
  readonly attachmentIds?: readonly string[];
}
/**
 * The restorer's answer without its message, plus the one failure only the lookup by lane ID has.
 * A lane being opened says which backend it runs on: a Claude window waits on a confirmation.
 */
export type IssueWakeResult =
  | { readonly status: "launch_requested" | "skipped_launching"; readonly backend: BackendName }
  | { readonly status: "skipped_online" }
  | { readonly status: "failed"; readonly reason: "no_binding" | "session_not_found" | "invalid_startup_cwd" | "backend_unavailable" | "terminal_launch_failed" };
export interface ReplyIssueInput {
  readonly operationKey: string;
  readonly issueId: string;
  /** May be blank when files are sent. */
  readonly body: string;
  readonly questionId?: string;
  /** Uploads this entry takes; at most ten. */
  readonly attachmentIds?: readonly string[];
}
export interface CloseIssueInput { readonly operationKey: string; readonly issueId: string; readonly body: string }
/** A lane ending its own issue; the reason goes into the issue's history. */
export interface LaneCloseIssueInput { readonly operationKey: string; readonly issueId: string; readonly reason: string }
export interface ReadIssueInput { readonly operationKey: string; readonly issueId: string; readonly throughSeq: number }
export interface RecordProcessedInput { readonly operationKey: string; readonly issueId: string; readonly deliveryId: string }
export interface IssueProcessedResult { readonly issueId: string; readonly deliveryId: string; readonly processedAt: number }
export interface IssueEntryResult {
  readonly issueId: string;
  readonly entryId: string;
  readonly entrySeq: number;
  readonly questionId?: string;
  readonly deliveryId?: string;
}
