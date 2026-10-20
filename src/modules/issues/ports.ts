import type { LaneAccess } from "../../router/lane-access.js";
import type { IssueDelivery, IssueEntry, IssueListQuery, IssueOperation, IssueQuestion, IssueThread, IssueWakeResult } from "./types.js";

export interface IssueListRow extends IssueThread {
  readonly waitingUserCount: number;
  readonly waitingLaneCount: number;
  readonly unreadLaneCount: number;
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
  listThreads(query: IssueListQuery, ownerLaneId?: string): readonly IssueListRow[];
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
  close(): void;
}

/** Opens a lane's existing conversation when it is not open; never creates one or changes its model. */
export interface IssueWakePort {
  wake(laneId: string): Promise<IssueWakeResult>;
}

export interface IssuesServiceOptions {
  readonly store: IssueStore;
  readonly lanes: LaneAccess;
  /** Absent when this Router cannot open windows; then nothing is said about waking at all. */
  readonly wake?: IssueWakePort;
  readonly now?: () => number;
  readonly newId?: () => string;
}
