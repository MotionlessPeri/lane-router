import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { DeliveryHandoff, DeliveryProcessing, IssueListRow, IssueOwnerCount, IssueStore } from "./ports.js";
import { initializeIssueSchema } from "./schema.js";
import type { IssueAttachment, IssueDelivery, IssueEntry, IssueFilter, IssueListQuery, IssueOperation, IssueQuestion, IssueThread } from "./types.js";

const THREAD = `id,owner_lane_id AS ownerLaneId,title,origin_kind AS originKind,status,
  created_at AS createdAt,updated_at AS updatedAt,closed_at AS closedAt,closed_by AS closedBy,read_seq AS readSeq,next_seq AS nextSeq`;
const ENTRY = `id,issue_id AS issueId,seq,kind,author,source,body,related_entry_id AS relatedEntryId,
  recorded_by_binding_id AS recordedByBindingId,recorded_by_generation AS recordedByGeneration,created_at AS createdAt`;
const QUESTION = `id,issue_id AS issueId,prompt_entry_id AS promptEntryId,asked_to AS askedTo,status,
  answer_entry_id AS answerEntryId,reason`;
const ATTACHMENT = `id,issue_id AS issueId,entry_id AS entryId,file_name AS fileName,media_type AS mediaType,size,sha256,
  stored_path AS storedPath,created_at AS createdAt`;
const DELIVERY = `id,issue_id AS issueId,entry_id AS entryId,owner_lane_id AS ownerLaneId,body,
  source_kind AS sourceKind,source_origin AS sourceOrigin,request_key AS requestKey,handoff_state AS handoffState,
  core_message_id AS coreMessageId,attempt_count AS attemptCount,next_attempt_at AS nextAttemptAt,
  last_error AS lastError,last_target_state AS lastTargetState,processed_at AS processedAt,
  processed_by_binding_id AS processedByBindingId,processed_by_generation AS processedByGeneration,created_at AS createdAt`;

// What 待我处理 means, for a thread aliased t: the list and the per-project counts use this one text.
const WAITING_USER = "(SELECT count(*) FROM issue_question q WHERE q.issue_id=t.id AND q.status='waiting_user')";
const UNREAD = "(SELECT count(*) FROM issue_entry e WHERE e.issue_id=t.id AND e.author='lane' AND e.kind!='event' AND e.seq>t.read_seq)";
// An issue the lane ended may end on an answer the user has not read; it waits for that reading.
const ATTENTION = `((t.status='open' AND (${WAITING_USER}>0 OR ${UNREAD}>0)) OR (t.status='closed' AND t.closed_by='lane' AND ${UNREAD}>0))`;
/** The condition a filter puts on a thread aliased t; open and closed name the status as @status. */
function filtered(filter: IssueFilter): string {
  return filter === "all" ? "1" : filter === "attention" ? ATTENTION : "t.status=@status";
}

/** Explicit composition boundary: importing this module or constructing the service opens nothing. */
export function openIssueStore(path: string): SqliteIssueStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  try {
    database.pragma("foreign_keys=ON");
    initializeIssueSchema(database);
    database.pragma("journal_mode=WAL");
    database.pragma("synchronous=FULL");
    return new SqliteIssueStore(database);
  } catch (error) {
    database.close();
    throw error;
  }
}

export class SqliteIssueStore implements IssueStore {
  constructor(private readonly database: Database.Database) {}

  transaction<T>(work: () => T): T { return this.database.transaction(work)(); }

  thread(id: string): IssueThread | null {
    return this.database.prepare(`SELECT ${THREAD} FROM issue_thread WHERE id=?`).get(id) as IssueThread | undefined ?? null;
  }

  insertThread(thread: IssueThread): void {
    this.database.prepare(`INSERT INTO issue_thread(id,owner_lane_id,title,origin_kind,status,created_at,updated_at,closed_at,closed_by,read_seq,next_seq)
      VALUES(@id,@ownerLaneId,@title,@originKind,@status,@createdAt,@updatedAt,@closedAt,@closedBy,@readSeq,@nextSeq)`).run(thread);
  }

  updateThread(thread: IssueThread): void {
    this.database.prepare(`UPDATE issue_thread SET status=@status,updated_at=@updatedAt,closed_at=@closedAt,closed_by=@closedBy,
      read_seq=@readSeq,next_seq=@nextSeq WHERE id=@id`).run(thread);
  }

  listThreads(query: IssueListQuery, ownerLaneId?: string, ownerLaneIds?: readonly string[]): readonly IssueListRow[] {
    const filter = query.filter ?? "attention";
    const columns = THREAD.split(",").map((column) => `t.${column.trim()}`).join(",");
    return this.database.prepare(`SELECT ${columns},${WAITING_USER} AS waitingUserCount,
      (SELECT count(*) FROM issue_question q WHERE q.issue_id=t.id AND q.status='waiting_lane') AS waitingLaneCount,
      ${UNREAD} AS unreadLaneCount FROM issue_thread t
      WHERE (@owner IS NULL OR t.owner_lane_id=@owner) AND (@owners IS NULL OR t.owner_lane_id IN (SELECT value FROM json_each(@owners)))
      AND (${filtered(filter)})
      AND (@beforeId IS NULL OR t.updated_at<@beforeTime OR (t.updated_at=@beforeTime AND t.id<@beforeId))
      ORDER BY t.updated_at DESC,t.id DESC LIMIT @limit`).all({
      owner: ownerLaneId ?? null, owners: ownerLaneIds === undefined ? null : JSON.stringify(ownerLaneIds), status: filter,
      beforeId: query.before?.id ?? null, beforeTime: query.before?.updatedAt ?? null, limit: query.limit ?? 50,
    }) as IssueListRow[];
  }

  waitingThreads(ownerLaneId: string): readonly { readonly id: string; readonly title: string; readonly waitingUser: number; readonly waitingLane: number }[] {
    return this.database.prepare(`SELECT t.id,t.title,
      (SELECT count(*) FROM issue_question q WHERE q.issue_id=t.id AND q.status='waiting_user') AS waitingUser,
      (SELECT count(*) FROM issue_question q WHERE q.issue_id=t.id AND q.status='waiting_lane') AS waitingLane
      FROM issue_thread t WHERE t.owner_lane_id=? AND EXISTS (SELECT 1 FROM issue_question q WHERE q.issue_id=t.id AND q.status IN ('waiting_user','waiting_lane'))
      ORDER BY t.id`).all(ownerLaneId) as { id: string; title: string; waitingUser: number; waitingLane: number }[];
  }

  threadsByRef(ref: string): readonly IssueThread[] {
    // Eight hex digits hold no % or _, so the prefix needs no escaping.
    return this.database.prepare(`SELECT ${THREAD} FROM issue_thread WHERE ${ref.length === 8 ? "id LIKE ? || '%'" : "id=?"} ORDER BY id LIMIT 2`).all(ref) as IssueThread[];
  }

  ownerLaneIds(): readonly string[] {
    return (this.database.prepare("SELECT DISTINCT owner_lane_id AS id FROM issue_thread ORDER BY owner_lane_id").all() as { id: string }[]).map((row) => row.id);
  }

  countsByOwner(filter: IssueFilter): readonly IssueOwnerCount[] {
    return this.database.prepare(`SELECT t.owner_lane_id AS ownerLaneId,
      sum(CASE WHEN ${filtered(filter)} THEN 1 ELSE 0 END) AS count, sum(CASE WHEN ${ATTENTION} THEN 1 ELSE 0 END) AS attentionCount
      FROM issue_thread t GROUP BY t.owner_lane_id ORDER BY t.owner_lane_id`).all({ status: filter }) as IssueOwnerCount[];
  }

  entry(issueId: string, id: string): IssueEntry | null {
    return this.database.prepare(`SELECT ${ENTRY} FROM issue_entry WHERE issue_id=? AND id=?`).get(issueId, id) as IssueEntry | undefined ?? null;
  }

  entries(issueId: string, afterSeq: number, limit: number): readonly IssueEntry[] {
    return this.database.prepare(`SELECT ${ENTRY} FROM issue_entry WHERE issue_id=? AND seq>? ORDER BY seq LIMIT ?`).all(issueId, afterSeq, limit) as IssueEntry[];
  }

  insertEntry(entry: IssueEntry): void {
    this.database.prepare(`INSERT INTO issue_entry(id,issue_id,seq,kind,author,source,body,related_entry_id,recorded_by_binding_id,recorded_by_generation,created_at)
      VALUES(@id,@issueId,@seq,@kind,@author,@source,@body,@relatedEntryId,@recordedByBindingId,@recordedByGeneration,@createdAt)`).run(entry);
  }

  question(issueId: string, id: string): IssueQuestion | null {
    return this.database.prepare(`SELECT ${QUESTION} FROM issue_question WHERE issue_id=? AND id=?`).get(issueId, id) as IssueQuestion | undefined ?? null;
  }

  questions(issueId: string): readonly IssueQuestion[] {
    return this.database.prepare(`SELECT ${QUESTION.split(",").map((column) => `q.${column.trim()}`).join(",")}
      FROM issue_question q JOIN issue_entry e ON e.issue_id=q.issue_id AND e.id=q.prompt_entry_id
      WHERE q.issue_id=? ORDER BY e.seq`).all(issueId) as IssueQuestion[];
  }

  insertQuestion(question: IssueQuestion): void {
    this.database.prepare(`INSERT INTO issue_question(id,issue_id,prompt_entry_id,asked_to,status,answer_entry_id,reason)
      VALUES(@id,@issueId,@promptEntryId,@askedTo,@status,@answerEntryId,@reason)`).run(question);
  }

  updateQuestion(question: IssueQuestion): void {
    this.database.prepare(`UPDATE issue_question SET status=@status,answer_entry_id=@answerEntryId,reason=@reason
      WHERE issue_id=@issueId AND id=@id`).run(question);
  }

  operation(actorScope: string, operation: string, key: string): IssueOperation | null {
    return this.database.prepare(`SELECT actor_scope AS actorScope,operation,operation_key AS operationKey,
      request_digest AS requestDigest,result_json AS resultJson,created_at AS createdAt
      FROM issue_operation WHERE actor_scope=? AND operation=? AND operation_key=?`).get(actorScope, operation, key) as IssueOperation | undefined ?? null;
  }

  insertOperation(operation: IssueOperation): void {
    this.database.prepare(`INSERT INTO issue_operation(actor_scope,operation,operation_key,request_digest,result_json,created_at)
      VALUES(@actorScope,@operation,@operationKey,@requestDigest,@resultJson,@createdAt)`).run(operation);
  }

  insertDelivery(delivery: IssueDelivery): void {
    this.database.prepare(`INSERT INTO issue_delivery(id,issue_id,entry_id,owner_lane_id,body,source_kind,source_origin,request_key,
      handoff_state,core_message_id,attempt_count,next_attempt_at,last_error,last_target_state,processed_at,
      processed_by_binding_id,processed_by_generation,created_at)
      VALUES(@id,@issueId,@entryId,@ownerLaneId,@body,@sourceKind,@sourceOrigin,@requestKey,@handoffState,@coreMessageId,
      @attemptCount,@nextAttemptAt,@lastError,@lastTargetState,@processedAt,@processedByBindingId,@processedByGeneration,@createdAt)`).run(delivery);
  }

  delivery(id: string): IssueDelivery | null {
    return this.database.prepare(`SELECT ${DELIVERY} FROM issue_delivery WHERE id=?`).get(id) as IssueDelivery | undefined ?? null;
  }

  deliveries(issueId: string): readonly IssueDelivery[] {
    return this.database.prepare(`SELECT ${DELIVERY} FROM issue_delivery WHERE issue_id=? ORDER BY created_at,id`).all(issueId) as IssueDelivery[];
  }

  pendingDeliveries(now: number, limit: number): readonly IssueDelivery[] {
    return this.database.prepare(`SELECT ${DELIVERY} FROM issue_delivery WHERE handoff_state='pending' AND next_attempt_at<=?
      ORDER BY next_attempt_at,id LIMIT ?`).all(now, limit) as IssueDelivery[];
  }

  updateDeliveryHandoff(id: string, handoff: DeliveryHandoff): void {
    this.database.prepare(`UPDATE issue_delivery SET handoff_state=@handoffState,core_message_id=@coreMessageId,
      attempt_count=@attemptCount,next_attempt_at=@nextAttemptAt,last_error=@lastError,last_target_state=@lastTargetState
      WHERE id=@id`).run({ id, ...handoff });
  }

  updateDeliveryProcessing(id: string, processing: DeliveryProcessing): void {
    this.database.prepare(`UPDATE issue_delivery SET processed_at=@processedAt,processed_by_binding_id=@processedByBindingId,
      processed_by_generation=@processedByGeneration WHERE id=@id`).run({ id, ...processing });
  }

  insertAttachment(attachment: IssueAttachment): void {
    this.database.prepare(`INSERT INTO issue_attachment(id,issue_id,entry_id,file_name,media_type,size,sha256,stored_path,created_at)
      VALUES(@id,@issueId,@entryId,@fileName,@mediaType,@size,@sha256,@storedPath,@createdAt)`).run(attachment);
  }

  attachment(id: string): IssueAttachment | null {
    return this.database.prepare(`SELECT ${ATTACHMENT} FROM issue_attachment WHERE id=?`).get(id) as IssueAttachment | undefined ?? null;
  }

  attachmentsOfIssue(issueId: string): readonly IssueAttachment[] {
    return this.database.prepare(`SELECT ${ATTACHMENT} FROM issue_attachment WHERE issue_id=? ORDER BY created_at,id`).all(issueId) as IssueAttachment[];
  }

  claimAttachment(id: string, issueId: string, entryId: string): boolean {
    return this.database.prepare("UPDATE issue_attachment SET issue_id=?,entry_id=? WHERE id=? AND entry_id IS NULL").run(issueId, entryId, id).changes === 1;
  }

  unclaimedAttachments(createdBefore: number): readonly IssueAttachment[] {
    return this.database.prepare(`SELECT ${ATTACHMENT} FROM issue_attachment WHERE entry_id IS NULL AND created_at<? ORDER BY created_at,id`).all(createdBefore) as IssueAttachment[];
  }

  deleteUnclaimedAttachment(id: string): boolean {
    return this.database.prepare("DELETE FROM issue_attachment WHERE id=? AND entry_id IS NULL").run(id).changes === 1;
  }

  close(): void { if (this.database.open) this.database.close(); }
}
