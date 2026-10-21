import type { LaneAccess } from "../../router/lane-access.js";
import type { IssueAttachment, IssueDelivery, IssueEntry, IssueFilter, IssueListQuery, IssueOperation, IssueQuestion, IssueThread, IssueWakeResult } from "./types.js";

export interface IssueListRow extends IssueThread {
  readonly waitingUserCount: number;
  readonly waitingLaneCount: number;
  readonly unreadLaneCount: number;
}
/** One owner lane's issues: how many a filter lists, and how many are in 待我处理. */
export interface IssueOwnerCount {
  readonly ownerLaneId: string;
  readonly count: number;
  readonly attentionCount: number;
}

/** Only handoff facts change here; the saved payload and processing receipt are independent. */
export interface DeliveryHandoff {
  readonly handoffState: IssueDelivery["handoffState"];
  readonly coreMessageId: string | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  readonly lastTargetState: string | null;
}
export interface DeliveryProcessing {
  readonly processedAt: number;
  readonly processedByBindingId: string;
  readonly processedByGeneration: number;
}

/** Synchronous transactions keep authorization rechecks adjacent to durable writes. */
export interface IssueStore {
  transaction<T>(work: () => T): T;
  thread(id: string): IssueThread | null;
  insertThread(thread: IssueThread): void;
  updateThread(thread: IssueThread): void;
  /** The issue that holds this card, if one does. */
  threadByTask(task: string): IssueThread | null;
  /** `ownerLaneIds`, when given, keeps only those owners' issues; empty keeps none. */
  listThreads(query: IssueListQuery, ownerLaneId?: string, ownerLaneIds?: readonly string[]): readonly IssueListRow[];
  /** A lane's issues with any question waiting, on the user or on the lane, with how many of each. */
  waitingThreads(ownerLaneId: string): readonly { readonly id: string; readonly title: string; readonly waitingUser: number; readonly waitingLane: number }[];
  /** Every lane that owns at least one issue. */
  ownerLaneIds(): readonly string[];
  /** The issues a whole ID or an eight-digit prefix names, lowercase; at most two, enough to tell one from many. */
  threadsByRef(ref: string): readonly IssueThread[];
  countsByOwner(filter: IssueFilter): readonly IssueOwnerCount[];
  entry(issueId: string, id: string): IssueEntry | null;
  entries(issueId: string, afterSeq: number, limit: number): readonly IssueEntry[];
  insertEntry(entry: IssueEntry): void;
  question(issueId: string, id: string): IssueQuestion | null;
  questions(issueId: string): readonly IssueQuestion[];
  insertQuestion(question: IssueQuestion): void;
  updateQuestion(question: IssueQuestion): void;
  operation(actorScope: string, operation: string, key: string): IssueOperation | null;
  insertOperation(operation: IssueOperation): void;
  insertDelivery(delivery: IssueDelivery): void;
  delivery(id: string): IssueDelivery | null;
  deliveries(issueId: string): readonly IssueDelivery[];
  pendingDeliveries(now: number, limit: number): readonly IssueDelivery[];
  updateDeliveryHandoff(id: string, handoff: DeliveryHandoff): void;
  /** Persistence primitive only; caller authorization and receipt idempotency belong to the service. */
  updateDeliveryProcessing(id: string, processing: DeliveryProcessing): void;
  insertAttachment(attachment: IssueAttachment): void;
  attachment(id: string): IssueAttachment | null;
  /** Every attachment an issue's entries took, in upload order. */
  attachmentsOfIssue(issueId: string): readonly IssueAttachment[];
  /**
   * Gives an unclaimed attachment to an entry, at its place among the files that entry was sent
   * with; false when it is gone or another entry has it.
   */
  claimAttachment(id: string, issueId: string, entryId: string, position: number): boolean;
  unclaimedAttachments(createdBefore: number): readonly IssueAttachment[];
  /** Removes the row only while no entry has claimed it; true when a row went. */
  deleteUnclaimedAttachment(id: string): boolean;
  close(): void;
}

/** Opens a lane's existing conversation when it is not open; never creates one or changes its model. */
export interface IssueWakePort {
  wake(laneId: string): Promise<IssueWakeResult>;
}

/** Where a lane's work lives in git: the checkout's top level, and a GitHub remote's web address. */
export interface LaneRepo {
  readonly root: string;
  /** Null when the remote is not on GitHub, or there is none: then there is nowhere to link a commit. */
  readonly webUrl: string | null;
}

/** Finds the repository a lane works in; null when it has no known directory or that is not a checkout. */
export interface LaneRepoPort {
  repoForLane(laneId: string): Promise<LaneRepo | null>;
}

export interface IssuesServiceOptions {
  readonly store: IssueStore;
  readonly lanes: LaneAccess;
  /** Absent when this Router cannot open windows; then nothing is said about waking at all. */
  readonly wake?: IssueWakePort;
  /** For linking commit ids to the issue's own lane's repository; absent means no commit is linked. */
  readonly repos?: LaneRepoPort;
  readonly now?: () => number;
  readonly newId?: () => string;
}
