export type IssueOrigin = "answer" | "question";
export type IssueStatus = "open" | "closed";
export type QuestionStatus = "waiting_user" | "waiting_lane" | "answered" | "not_needed";
export type EntryKind = "question" | "answer" | "reply" | "event";
export type EntrySource = "agent" | "user_page" | "agent_reported_tui_user";
export type AttentionReason = "waiting_user" | "unread_lane_content";

export class IssueError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "INVALID_REFERENCE" | "ISSUE_NOT_FOUND" | "ISSUE_CLOSED" | "LANE_UNAVAILABLE" | "OPERATION_CONFLICT", message: string) {
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
  readonly readSeq: number;
  readonly nextSeq: number;
}

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

export interface IssueOperation {
  readonly actorScope: string;
  readonly operation: string;
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly resultJson: string;
  readonly createdAt: number;
}

export interface IssueCursor { readonly updatedAt: number; readonly id: string }
export interface IssueListQuery {
  readonly filter?: "attention" | "open" | "closed" | "all";
  readonly before?: IssueCursor;
  readonly limit?: number;
}
export interface IssueHistoryQuery { readonly afterSeq?: number; readonly limit?: number }
export interface IssueOwner {
  readonly laneId: string;
  readonly address: string | null;
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
export interface IssueDetail {
  readonly thread: IssueThread;
  readonly owner: IssueOwner;
  readonly entries: readonly IssueEntry[];
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
export interface ReplyIssueInput {
  readonly operationKey: string;
  readonly issueId: string;
  readonly body: string;
  readonly questionId?: string;
}
export interface CloseIssueInput { readonly operationKey: string; readonly issueId: string; readonly body: string }
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
