import { createHash, randomUUID } from "node:crypto";

import { isAddressSegment } from "../../router/address.js";
import type { ActiveLane, LaneAccessFacts, LaneCallerIdentity } from "../../router/lane-access.js";
import type { CallerContext } from "../../router/types.js";
import { ATTACHMENTS_PER_ENTRY } from "./attachments.js";
import type { IssuesServiceOptions, IssueStore } from "./ports.js";
import {
  IssueError,
  type AppendIssueInput, type AttentionReason, type CloseIssueInput, type CreateIssueInput, type IssueAttachment, type IssueAttachmentInfo, type IssueDetail,
  type IssueEntry, type IssueEntryResult, type IssueHistoryQuery, type IssueList,
  type IssueCloser, type IssueFilter, type IssueListQuery, type IssueOwner, type IssuePresence, type IssueProcessedResult, type IssueProjectCount,
  type IssueProjects, type IssueQuestion, type IssueRefs, type IssueThread,
  type IssueTaskResult, type IssueWakeResult, type LaneCloseIssueInput, type PublishIssueInput, type ReadIssueInput, type RecordProcessedInput, type ReplyIssueInput,
  type SetIssueTaskInput, type UpdateIssueQuestionInput,
} from "./types.js";

/** Business authority is here; clients display saved facts and never infer completion from delivery. */
export class IssuesService {
  private readonly store: IssueStore;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: IssuesServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  publish(context: CallerContext, input: PublishIssueInput): IssueEntryResult {
    fields(input, ["operationKey", "title", "kind", "body", "originalQuestion", "task"]);
    const operationKey = text(input.operationKey, "operationKey");
    const title = text(input.title, "title").trim();
    const body = text(input.body, "body");
    if (input.kind !== "answer" && input.kind !== "question") invalid("Only answer and question issues may be published");
    if (input.kind === "question" && "originalQuestion" in input) invalid("A proactive question has no originalQuestion");
    const originalQuestion = input.kind === "answer" ? text(input.originalQuestion, "originalQuestion") : null;
    const task = input.task === undefined ? null : taskRef(input.task);
    // A card counts toward the operation only when given, so publishes saved before cards replay as they were.
    const payload = { title, kind: input.kind, body, originalQuestion, ...(task === null ? {} : { task }) };
    return this.agentWrite(context, "publish", operationKey, payload, undefined, (actor) => {
      if (task !== null) this.requireFreeTask(task);
      const now = this.now();
      const issueId = this.newId();
      this.store.insertThread({ id: issueId, ownerLaneId: actor.laneId, title, originKind: input.kind,
        status: "open", createdAt: now, updatedAt: now, closedAt: null, closedBy: null, readSeq: 0, nextSeq: 1, task });
      if (originalQuestion !== null) {
        const prompt = this.addEntry(issueId, "question", "user", "agent_reported_tui_user", originalQuestion, null, actor);
        const answer = this.addEntry(issueId, "answer", "lane", "agent", body, prompt.id, actor);
        const question = this.addQuestion(prompt, "lane", "answered", answer.id);
        return result(answer, question.id);
      }
      const prompt = this.addEntry(issueId, "question", "lane", "agent", body, null, actor);
      return result(prompt, this.addQuestion(prompt, "user", "waiting_user").id);
    });
  }

  append(context: CallerContext, input: AppendIssueInput): IssueEntryResult {
    fields(input, ["operationKey", "issueId", "kind", "body", "questionId"]);
    const operationKey = text(input.operationKey, "operationKey");
    const issueId = text(input.issueId, "issueId");
    const body = text(input.body, "body");
    const questionId = optionalId(input.questionId);
    if (!["answer", "explanation", "question", "tui_user"].includes(input.kind)) invalid("Unsupported append kind");
    if (input.kind === "question" && questionId !== null) invalid("A new question cannot replace another question");
    if (input.kind === "explanation" && questionId === null) invalid("An explanation must identify its question");
    return this.agentWrite(context, "append", operationKey, { issueId, kind: input.kind, body, questionId }, issueId, (actor) => {
      const question = questionId === null ? null : this.requireQuestion(issueId, questionId);
      const tui = input.kind === "tui_user";
      const entry = this.addEntry(issueId, tui ? "reply" : input.kind === "question" ? "question" : "answer",
        tui ? "user" : "lane", tui ? "agent_reported_tui_user" : "agent", body, question?.promptEntryId ?? null, actor);
      if (input.kind === "question") return result(entry, this.addQuestion(entry, "user", "waiting_user").id);
      if (tui) return result(entry, this.userTurn(entry, question).id);
      if (input.kind === "explanation" && question) this.waitFor(question, "waiting_user");
      // The user has replied and is waiting on this lane; an answer naming that question is the
      // end of it. A question still waiting on the user is not the lane's to settle.
      if (input.kind === "answer" && question?.status === "waiting_lane") this.resolve(issueId, question, "answered", entry.id, null, actor);
      return result(entry, question?.id);
    });
  }

  updateQuestion(context: CallerContext, input: UpdateIssueQuestionInput): { issueId: string; questionId: string } {
    fields(input, ["operationKey", "issueId", "questionId", "status", "answerEntryId", "reason"]);
    const operationKey = text(input.operationKey, "operationKey");
    const issueId = text(input.issueId, "issueId");
    const questionId = text(input.questionId, "questionId");
    if (input.status !== "answered" && input.status !== "not_needed") invalid("Only a question may be answered or no longer needed");
    const answerEntryId = input.status === "answered" ? text(input.answerEntryId, "answerEntryId") : null;
    const reason = input.status === "not_needed" ? text(input.reason, "reason") : null;
    if (input.status === "answered" && "reason" in input || input.status === "not_needed" && "answerEntryId" in input) invalid("Question resolution fields do not match status");
    return this.agentWrite(context, "update_question", operationKey, { issueId, questionId, status: input.status, answerEntryId, reason }, issueId, (actor) => {
      const question = this.requireQuestion(issueId, questionId);
      if (answerEntryId !== null) {
        const answer = this.store.entry(issueId, answerEntryId);
        if (!answer || !["answer", "reply"].includes(answer.kind)) reference("An answered question needs a specific answer or reply in this issue");
      }
      this.resolve(issueId, question, input.status, answerEntryId, reason, actor);
      return { issueId, questionId };
    });
  }

  /** Dedicated report of the user's actual TUI words; the issue is ended by the user. */
  recordTuiClose(context: CallerContext, input: CloseIssueInput): IssueEntryResult {
    const normalized = closeInput(input);
    return this.agentWrite(context, "record_tui_close", normalized.operationKey, normalized, normalized.issueId,
      (actor) => this.end(normalized.issueId, normalized.body, "user", "agent_reported_tui_user", actor));
  }

  /**
   * The lane ends its own issue once its matter is done. A question still waiting on either side
   * keeps it open: one waiting on the lane is a reply it has not answered, which ending the issue
   * would carry off. The user can still reply, which reopens it; the lane cannot.
   */
  closeByLane(context: CallerContext, input: LaneCloseIssueInput): IssueEntryResult {
    fields(input, ["operationKey", "issueId", "reason"]);
    const operationKey = text(input.operationKey, "operationKey");
    const issueId = text(input.issueId, "issueId");
    const reason = text(input.reason, "reason");
    return this.agentWrite(context, "close", operationKey, { issueId, reason }, issueId, (actor) => {
      const waiting = this.store.questions(issueId).filter((question) => question.status === "waiting_user" || question.status === "waiting_lane");
      if (waiting.length > 0) {
        throw new IssueError("QUESTIONS_WAITING", `This issue still has waiting questions: ${waiting.map((question) => `${question.id} (${question.status})`).join(", ")}. `
          + "Answer each with lane_issue_append (kind answer, with its questionId), or mark it not_needed with lane_issue_update resolve_question, then close.");
      }
      return this.end(issueId, `lane 结束：${reason}`, "lane", "agent", actor);
    });
  }

  /**
   * Pairs the lane's issue with the card its work is on, or with none. An issue holds one card at a
   * time and a card one issue, so changing cards goes through null; the card it already has is no
   * change and writes nothing. Like other additions, it waits while the issue is ended.
   */
  setTask(context: CallerContext, input: SetIssueTaskInput): IssueTaskResult {
    fields(input, ["operationKey", "issueId", "task"]);
    const operationKey = text(input.operationKey, "operationKey");
    const issueId = text(input.issueId, "issueId");
    if (!("task" in input)) invalid("task must be a card such as LR-56, or null");
    const task = input.task === null ? null : taskRef(input.task);
    return this.agentWrite(context, "set_task", operationKey, { issueId, task }, issueId, (actor) => {
      const thread = this.requireThread(issueId);
      if (thread.task === task) return { issueId, task };
      if (task !== null && thread.task !== null) {
        throw new IssueError("TASK_ALREADY_SET", `This issue already has card ${thread.task}; set task to null first, then to ${task}.`);
      }
      if (task !== null) this.requireFreeTask(task);
      this.store.updateThread({ ...thread, task });
      this.addEntry(issueId, "event", "lane", "agent", task === null ? `lane 去掉卡 ${thread.task}` : `lane 配上卡 ${task}`, null, actor);
      return { issueId, task };
    });
  }

  /** Processing is an independent saved fact, including for a reply whose issue has since closed. */
  recordProcessed(context: CallerContext, input: RecordProcessedInput): IssueProcessedResult {
    fields(input, ["operationKey", "issueId", "deliveryId"]);
    const operationKey = text(input.operationKey, "operationKey");
    const issueId = text(input.issueId, "issueId");
    const deliveryId = text(input.deliveryId, "deliveryId");
    return this.agentWrite(context, "record_processed", operationKey, { issueId, deliveryId }, issueId, (actor) => {
      const delivery = this.store.delivery(deliveryId);
      if (!delivery || delivery.issueId !== issueId || delivery.ownerLaneId !== actor.laneId) reference("Delivery does not belong to this issue and owner");
      if (delivery.processedAt !== null) throw new IssueError("OPERATION_CONFLICT", "This delivery already has a processing receipt");
      const processedAt = this.now();
      this.store.updateDeliveryProcessing(deliveryId, { processedAt, processedByBindingId: actor.bindingId, processedByGeneration: actor.generation });
      return { issueId, deliveryId, processedAt };
    }, true);
  }

  /**
   * What in a lane's issues still waits on someone, one sentence per issue, for the core to name
   * when a task lane tries to finish: an issue left waiting would be stranded once its lane is gone.
   */
  waitingIssues(laneId: string): string[] {
    return this.store.waitingThreads(laneId).map((thread) => {
      const waits = [
        ...(thread.waitingUser > 0 ? [`${thread.waitingUser} 个问题等用户回答`] : []),
        ...(thread.waitingLane > 0 ? [`${thread.waitingLane} 个问题等 lane 答复`] : []),
      ];
      return `问答 \`${thread.id}\`（${thread.title}）：${waits.join("，")}`;
    });
  }

  listForLane(context: CallerContext, query: IssueListQuery = {}): IssueList {
    const actor = this.options.lanes.resolveCaller(context);
    // A lane sees only its own issues; choosing a project is the page's.
    fields(query, ["filter", "before", "limit"]);
    return this.listOwned({ ...query, filter: query.filter ?? "all" }, actor.laneId);
  }

  readForLane(context: CallerContext, issueId: string, query: IssueHistoryQuery = {}): IssueDetail {
    const actor = this.options.lanes.resolveCaller(context);
    this.requireOwned(issueId, actor.laneId);
    return this.detail(issueId, query);
  }

  list(query: IssueListQuery = {}): IssueList { return this.listOwned(query); }

  /**
   * Which of these references name exactly one issue: a whole ID in either case, or its first eight
   * hex digits. One that names none or several is left out; the page's alone, not a lane tool's.
   */
  resolveRefs(refs: readonly string[], lanes: readonly string[] = []): IssueRefs {
    if (!Array.isArray(refs) || refs.length > 100) invalid("refs must be a list of at most 100 references");
    for (const ref of refs) if (typeof ref !== "string" || !ISSUE_REF.test(ref)) invalid("A reference is a whole issue ID or exactly eight hex digits");
    if (!Array.isArray(lanes) || lanes.length > 100) invalid("lanes must be a list of at most 100 addresses");
    for (const lane of lanes) if (!isLaneAddress(lane)) invalid("lanes must hold lane addresses");
    const items = refs.flatMap((ref) => {
      const found = this.store.threadsByRef(ref.toLowerCase());
      if (found.length !== 1) return [];
      const { id, title, status, ownerLaneId } = found[0]!;
      return [{ ref, id, title, status, ownerAddress: this.owner(ownerLaneId).address }];
    });
    // An address exists here when a lane that holds issues has had it, archived or not.
    const known = new Map<string, string>();
    if (lanes.length > 0) {
      for (const laneId of this.store.ownerLaneIds()) {
        const facts = this.options.lanes.readLane(laneId);
        if (facts) known.set(facts.address, facts.project);
      }
    }
    return { items, lanes: lanes.flatMap((address) => known.has(address) ? [{ address, project: known.get(address)! }] : []) };
  }

  /** Each project that has an issue, with lanes gone gathered under null at the end. */
  projects(query: { readonly filter?: IssueFilter } = {}): IssueProjects {
    fields(query, ["filter"]);
    const filter = listFilter(query.filter);
    const byProject = new Map<string | null, IssueProjectCount>();
    for (const { ownerLaneId, count, attentionCount } of this.store.countsByOwner(filter)) {
      const project = this.options.lanes.readLane(ownerLaneId)?.project ?? null;
      const sum = byProject.get(project) ?? { project, count: 0, attentionCount: 0 };
      byProject.set(project, { project, count: sum.count + count, attentionCount: sum.attentionCount + attentionCount });
    }
    const items = [...byProject.values()].sort((left, right) => left.project === null ? 1 : right.project === null ? -1
      : left.project.localeCompare(right.project, undefined, { sensitivity: "base" }));
    return { items };
  }

  detail(issueId: string, query: IssueHistoryQuery = {}): IssueDetail {
    text(issueId, "issueId");
    fields(query, ["afterSeq", "limit"]);
    const afterSeq = integer(query.afterSeq ?? 0, "afterSeq", 0);
    const limit = pageSize(query.limit);
    return this.store.transaction(() => {
      const thread = this.requireThread(issueId);
      if (afterSeq >= thread.nextSeq) invalid("History cursor exceeds this issue's saved sequence");
      const page = this.store.entries(issueId, afterSeq, limit + 1);
      const files = new Map<string, IssueAttachmentInfo[]>();
      for (const { entryId, id, fileName, size, mediaType, storedPath } of this.store.attachmentsOfIssue(issueId)) {
        files.set(entryId!, [...files.get(entryId!) ?? [], { id, fileName, size, mediaType, storedPath }]);
      }
      const entries = page.slice(0, limit).map((entry) => files.has(entry.id) ? { ...entry, attachments: files.get(entry.id)! } : entry);
      return { thread, owner: this.owner(thread.ownerLaneId), entries, questions: this.store.questions(issueId),
        deliveries: this.store.deliveries(issueId), displayedThroughSeq: entries.at(-1)?.seq ?? afterSeq,
        hasMore: page.length > limit };
    });
  }

  /**
   * The user opens a topic with one lane from the page. The lane is told these are the user's own
   * words, the same as typing in its TUI, and that the answer belongs in this issue. Who opened it
   * is the first entry's author; `originKind` keeps the schema's existing values.
   */
  create(input: CreateIssueInput): IssueEntryResult {
    fields(input, ["operationKey", "laneId", "title", "body", "attachmentIds"]);
    const operationKey = text(input.operationKey, "operationKey");
    const laneId = text(input.laneId, "laneId");
    const title = text(input.title, "title").trim();
    const attachmentIds = attachmentIdsOf(input.attachmentIds);
    const body = userText(input.body, attachmentIds);
    const payload = { laneId, title, body: input.body, ...(attachmentIds === null ? {} : { attachmentIds }) };
    return this.store.transaction(() => this.operation("user:local", "create", operationKey, payload, () => {
      const lane = this.options.lanes.readLane(laneId);
      // No conversation means nothing would ever read the delivery, and nothing could be woken.
      if (lane === null || lane.archivedAt !== null || lane.binding === null) {
        throw new IssueError("LANE_UNAVAILABLE", "The lane is missing, archived or has no conversation");
      }
      const now = this.now();
      const thread: IssueThread = { id: this.newId(), ownerLaneId: laneId, title, originKind: "question",
        status: "open", createdAt: now, updatedAt: now, closedAt: null, closedBy: null, readSeq: 0, nextSeq: 1, task: null };
      this.store.insertThread(thread);
      const entry = this.addEntry(thread.id, "question", "user", "user_page", body, null, null);
      const files = this.claim(entry, attachmentIds);
      const question = this.addQuestion(entry, "lane", "waiting_lane");
      const deliveryId = this.deliver(thread, entry, question.id, {
        opening: "用户在问答页新开了一个问答。这是用户本人的话，等同于在 TUI 里对你说的，按你处理用户指令的方式处理，不需要回 TUI 确认。答复写在这条问答里。",
        entryLabel: "条目", context: [`用户的话：\n${body}`, ...fileList(files)],
      });
      return { ...result(entry, question.id), deliveryId };
    }));
  }

  /** The lanes a new issue can go to. */
  listLanes(): { readonly items: readonly ActiveLane[] } {
    return { items: this.options.lanes.listActiveLanes() };
  }

  /**
   * Opens the issue's lane if it is not open, once a save has put a message in its mailbox. Waking
   * is never part of the save: a port that throws is a failed wake, and with no port there is
   * nothing to report.
   */
  async wakeOwner(issueId: string): Promise<IssueWakeResult | undefined> {
    const wake = this.options.wake;
    if (!wake) return undefined;
    const { ownerLaneId } = this.requireThread(issueId);
    try { return await wake.wake(ownerLaneId); }
    catch { return { status: "failed", reason: "terminal_launch_failed" }; }
  }

  /**
   * A reply to an ended issue reopens it, whoever ended it: ending stops the lane, never the user.
   * The reopening is recorded before the reply and told to the lane at the head of its letter.
   */
  reply(input: ReplyIssueInput): IssueEntryResult {
    fields(input, ["operationKey", "issueId", "body", "questionId", "attachmentIds"]);
    const operationKey = text(input.operationKey, "operationKey");
    const issueId = text(input.issueId, "issueId");
    const attachmentIds = attachmentIdsOf(input.attachmentIds);
    const body = userText(input.body, attachmentIds);
    const questionId = optionalId(input.questionId);
    // Files count toward the operation only when sent, so replies saved before they existed replay as they were.
    const payload = { issueId, body: input.body, questionId, ...(attachmentIds === null ? {} : { attachmentIds }) };
    return this.userWrite("reply", operationKey, payload, issueId, () => {
      const thread = this.requireThread(issueId);
      this.requireActiveLane(thread.ownerLaneId);
      const question = questionId === null ? null : this.requireQuestion(issueId, questionId);
      const reopened = thread.status === "closed";
      if (reopened) {
        this.store.updateThread({ ...thread, status: "open", closedAt: null, closedBy: null });
        this.addEntry(issueId, "event", "user", "user_page", "用户回复，议题重新打开", null, null);
      }
      const entry = this.addEntry(issueId, "reply", "user", "user_page", body, question?.promptEntryId ?? null, null);
      const files = this.claim(entry, attachmentIds);
      const round = this.userTurn(entry, question);
      const prompt = question === null ? null : this.store.entry(issueId, question.promptEntryId);
      const deliveryId = this.deliver(thread, entry, round.id, {
        opening: [
          ...(reopened ? [`这条问答原先已结束（由${thread.closedBy === "lane" ? " lane " : "用户"}结束），用户的回复让它重新打开了。`] : []),
          "用户已在议题页面回复，无需回 TUI 重复。请在原任务内继续处理。",
        ].join("\n"),
        entryLabel: "回复", context: [...(prompt ? [`关联问题：\n${prompt.body}`] : []), `用户回复：\n${body}`, ...fileList(files)],
      });
      return { ...result(entry, round.id), deliveryId };
    }, true);
  }

  markRead(input: ReadIssueInput): { issueId: string; readSeq: number } {
    fields(input, ["operationKey", "issueId", "throughSeq"]);
    const operationKey = text(input.operationKey, "operationKey");
    const issueId = text(input.issueId, "issueId");
    const throughSeq = integer(input.throughSeq, "throughSeq", 0);
    return this.userWrite("mark_read", operationKey, { issueId, throughSeq }, issueId, () => {
      const thread = this.requireThread(issueId);
      if (throughSeq >= thread.nextSeq) invalid("Read cursor exceeds saved content");
      const readSeq = Math.max(thread.readSeq, throughSeq);
      this.store.updateThread({ ...thread, readSeq });
      return { issueId, readSeq };
    }, true);
  }

  close(input: CloseIssueInput): IssueEntryResult {
    const normalized = closeInput(input);
    return this.userWrite("close", normalized.operationKey, normalized, normalized.issueId,
      () => this.end(normalized.issueId, normalized.body, "user", "user_page", null));
  }

  private listOwned(query: IssueListQuery, ownerLaneId?: string): IssueList {
    fields(query, ["filter", "before", "limit", "project", "lane"]);
    if (query.filter !== undefined) listFilter(query.filter);
    if (query.before !== undefined) {
      fields(query.before, ["updatedAt", "id"]);
      integer(query.before.updatedAt, "before.updatedAt", 0);
      text(query.before.id, "before.id");
    }
    const limit = pageSize(query.limit);
    const { project, lane, ...listed } = query;
    if (project !== undefined && (typeof project !== "string" || !isAddressSegment(project))) invalid("project must be one segment of a lane address");
    if (lane !== undefined && !isLaneAddress(lane)) invalid("lane must be a lane address");
    let owners: string[] | undefined;
    if (project !== undefined || lane !== undefined) {
      // Project and address live on the lane record, so the owners are found there, never stored twice.
      owners = this.store.ownerLaneIds().filter((laneId) => {
        const facts = this.options.lanes.readLane(laneId);
        return facts !== null && (project === undefined || facts.project === project) && (lane === undefined || facts.address === lane);
      });
      if (owners.length === 0) return { items: [], nextCursor: null };
    }
    const rows = this.store.listThreads({ ...listed, limit: limit + 1 }, ownerLaneId, owners);
    const items = rows.slice(0, limit).map(({ unreadLaneCount, ...thread }) => {
      const attentionReasons: AttentionReason[] = [];
      if (thread.status === "open") {
        if (thread.waitingUserCount > 0) attentionReasons.push("waiting_user");
        if (unreadLaneCount > 0) attentionReasons.push("unread_lane_content");
      } else if (thread.closedBy === "lane" && unreadLaneCount > 0) attentionReasons.push("unread_lane_content");
      return { ...thread, owner: this.owner(thread.ownerLaneId), attentionReasons };
    });
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? { updatedAt: last.updatedAt, id: last.id } : null };
  }

  private owner(laneId: string): IssueOwner {
    const facts = this.options.lanes.readLane(laneId);
    if (facts === null) return { laneId, address: null, project: null, state: "missing", presence: null, finishedAt: null, task: null };
    // The core names these only for a lane that finished or was archived; a page reads null for the rest.
    const { address, project } = facts, finishedAt = facts.finishedAt ?? null, task = facts.task ?? null;
    if (facts.archivedAt !== null) return { laneId, address, project, state: "archived", presence: null, finishedAt, task };
    return { laneId, address, project, state: "active", presence: presence(facts), finishedAt, task };
  }

  private agentWrite<T>(context: CallerContext, operation: string, key: string, payload: object, issueId: string | undefined, work: (actor: LaneCallerIdentity) => T, allowClosed = false): T {
    const actor = this.options.lanes.resolveCaller(context);
    if (issueId !== undefined) this.requireOwned(issueId, actor.laneId);
    this.options.lanes.assertCurrentCaller(context, actor);
    return this.store.transaction(() => this.operation(`lane:${actor.laneId}`, operation, key, payload, () => {
      this.requireActiveLane(actor.laneId);
      if (issueId !== undefined && !allowClosed) this.requireOpen(this.requireOwned(issueId, actor.laneId));
      return work(actor);
    }));
  }

  private userWrite<T>(operation: string, key: string, payload: object, issueId: string, work: () => T, allowClosed = false): T {
    this.requireThread(issueId);
    return this.store.transaction(() => this.operation("user:local", operation, key, payload, () => {
      if (!allowClosed) this.requireOpen(this.requireThread(issueId));
      return work();
    }));
  }

  private operation<T>(actorScope: string, operation: string, operationKey: string, payload: object, work: () => T): T {
    const requestDigest = createHash("sha256").update(canonical(payload)).digest("hex");
    const previous = this.store.operation(actorScope, operation, operationKey);
    if (previous) {
      if (previous.requestDigest !== requestDigest) throw new IssueError("OPERATION_CONFLICT", "This operation key already saved different content");
      return JSON.parse(previous.resultJson) as T;
    }
    const saved = work();
    this.store.insertOperation({ actorScope, operation, operationKey, requestDigest, resultJson: JSON.stringify(saved), createdAt: this.now() });
    return saved;
  }

  private requireThread(id: string): IssueThread {
    const thread = this.store.thread(id);
    if (!thread) throw new IssueError("ISSUE_NOT_FOUND", "Issue not found");
    return thread;
  }

  private requireOwned(id: string, laneId: string): IssueThread {
    const thread = this.requireThread(id);
    if (thread.ownerLaneId !== laneId) throw new IssueError("ISSUE_NOT_FOUND", "Issue not found in this lane");
    return thread;
  }

  private requireOpen(thread: IssueThread): void {
    if (thread.status === "closed") throw new IssueError("ISSUE_CLOSED", "This issue has been explicitly ended");
  }

  private requireFreeTask(task: string): void {
    const holder = this.store.threadByTask(task);
    if (holder) throw new IssueError("TASK_TAKEN", `Card ${task} already goes with issue ${holder.id}; a card goes with one issue only.`);
  }

  private requireActiveLane(laneId: string): void {
    const lane = this.options.lanes.readLane(laneId);
    if (lane === null || lane.archivedAt !== null) throw new IssueError("LANE_UNAVAILABLE", "The original owner lane is missing or archived");
  }

  private requireQuestion(issueId: string, id: string): IssueQuestion {
    const question = this.store.question(issueId, id);
    if (!question) reference("Question does not belong to this issue");
    return question;
  }

  private addEntry(issueId: string, kind: IssueEntry["kind"], author: IssueEntry["author"], source: IssueEntry["source"], body: string, relatedEntryId: string | null, actor: LaneCallerIdentity | null): IssueEntry {
    const thread = this.requireThread(issueId);
    const now = this.now();
    const entry: IssueEntry = { id: this.newId(), issueId, seq: thread.nextSeq, kind, author, source, body,
      relatedEntryId, recordedByBindingId: actor?.bindingId ?? null, recordedByGeneration: actor?.generation ?? null, createdAt: now };
    this.store.insertEntry(entry);
    this.store.updateThread({ ...thread, nextSeq: thread.nextSeq + 1, updatedAt: now });
    return entry;
  }

  /** Freeze the assembled context once. Delivery retries must never rebuild it from later history. */
  private deliver(thread: IssueThread, entry: IssueEntry, questionId: string, wording: { opening: string; entryLabel: string; context: readonly string[] }): string {
    const deliveryId = this.newId();
    const body = [
      wording.opening,
      `议题 ID: ${thread.id}\n标题: ${thread.title}\n所属 lane ID: ${thread.ownerLaneId}`,
      `${wording.entryLabel} entry ID: ${entry.id}\n投递 delivery ID: ${deliveryId}\n问题 ID: ${questionId}`,
      ...wording.context,
      `查询完整议题：调用 lane_issue_read，参数 ${JSON.stringify({ issueId: thread.id })}。`,
      `下一步：处理完后，用 lane_issue_append（kind: answer，questionId: ${questionId}）答复，该问题会自动标为已回答；再用 lane_issue_update 的 record_processed（deliveryId: ${deliveryId}）记录这次投递；最后用 lane_ack 确认这封邮件。`,
      "处理回执使用上述 delivery ID；入箱与处理完成是分别记录的事实。",
    ].join("\n\n");
    const now = this.now();
    this.store.insertDelivery({ id: deliveryId, issueId: thread.id, entryId: entry.id, ownerLaneId: thread.ownerLaneId,
      body, sourceKind: "user", sourceOrigin: "issues", requestKey: `issues:${deliveryId}`,
      handoffState: "pending", coreMessageId: null, attemptCount: 0, nextAttemptAt: now,
      lastError: null, lastTargetState: null, processedAt: null, processedByBindingId: null,
      processedByGeneration: null, createdAt: now });
    return deliveryId;
  }

  /** Gives the entry its uploads; one that is gone or already sent refuses the whole write. */
  private claim(entry: IssueEntry, attachmentIds: readonly string[] | null): readonly IssueAttachment[] {
    return (attachmentIds ?? []).map((id, position) => {
      if (!this.store.claimAttachment(id, entry.issueId, entry.id, position)) reference(`Attachment ${id} is missing, was cleaned up, or was already sent`);
      return this.store.attachment(id)!;
    });
  }

  private addQuestion(prompt: IssueEntry, askedTo: IssueQuestion["askedTo"], status: IssueQuestion["status"], answerEntryId: string | null = null): IssueQuestion {
    const question: IssueQuestion = { id: this.newId(), issueId: prompt.issueId, promptEntryId: prompt.id, askedTo, status, answerEntryId, reason: null };
    this.store.insertQuestion(question);
    return question;
  }

  /** Later turns replace current status, so a completion is also kept in immutable history. */
  private resolve(issueId: string, question: IssueQuestion, status: "answered" | "not_needed", answerEntryId: string | null, reason: string | null, actor: LaneCallerIdentity): void {
    this.store.updateQuestion({ ...question, status, answerEntryId, reason });
    const body = status === "answered"
      ? `问题 ${question.id} 已回答（answered）。\n答复 entry ID: ${answerEntryId}`
      : `问题 ${question.id} 无需回答（not_needed）。\n原因：${reason}`;
    this.addEntry(issueId, "event", "lane", "agent", body, question.promptEntryId, actor);
  }

  private waitFor(question: IssueQuestion, status: "waiting_user" | "waiting_lane"): IssueQuestion {
    const updated = { ...question, status, answerEntryId: null, reason: null };
    this.store.updateQuestion(updated);
    return updated;
  }

  private userTurn(entry: IssueEntry, question: IssueQuestion | null): IssueQuestion {
    return question ? this.waitFor(question, "waiting_lane") : this.addQuestion(entry, "lane", "waiting_lane");
  }

  /** The closing record's author is who ended the issue, and so is its saved closer. */
  private end(issueId: string, body: string, closedBy: IssueCloser, source: IssueEntry["source"], actor: LaneCallerIdentity | null): IssueEntryResult {
    const entry = this.addEntry(issueId, "event", closedBy, source, body, null, actor);
    const thread = this.requireThread(issueId);
    this.store.updateThread({ ...thread, status: "closed", closedAt: entry.createdAt, closedBy });
    return result(entry);
  }
}

function presence(facts: LaneAccessFacts): IssuePresence {
  if (facts.binding === null) return "offline";
  if (facts.reach?.state === "live") return facts.reach.believedBusy === true ? "busy" : "online";
  return facts.reach?.state === "unconfirmed" ? "unconfirmed" : "offline";
}

function result(entry: IssueEntry, questionId?: string): IssueEntryResult {
  return { issueId: entry.issueId, entryId: entry.id, entrySeq: entry.seq, ...(questionId === undefined ? {} : { questionId }) };
}

function fields(value: unknown, allowed: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("Expected an input object");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unexpected input field: ${key}`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${name} must be a nonempty string`);
  return value;
}

const ISSUE_REF = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8})$/iu;
/** `<project>/<lane>`, each part by the address rule. */
function isLaneAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  return parts.length === 2 && parts.every(isAddressSegment);
}

/** The filter asked for; none asked means 待我处理. */
function listFilter(value: unknown): IssueFilter {
  if (value === undefined) return "attention";
  if (typeof value !== "string" || !["attention", "all", "open", "closed"].includes(value)) invalid("Unsupported list filter");
  return value as IssueFilter;
}

const TASK_REF = /^[A-Z][A-Z0-9]*-\d+$/u;
/** A card as its board numbers it: an upper-case project, a dash and a number, such as LR-56. */
function taskRef(value: unknown): string {
  if (typeof value !== "string" || value.length > 32 || !TASK_REF.test(value)) {
    invalid("task must be a card such as LR-56: an upper-case project, a dash and a number, at most 32 characters");
  }
  return value;
}
function optionalId(value: unknown): string | null { return value === undefined ? null : text(value, "questionId"); }
function attachmentIdsOf(value: unknown): readonly string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.trim().length === 0)) invalid("attachmentIds must be a list of attachment IDs");
  if (value.length > ATTACHMENTS_PER_ENTRY) invalid(`At most ${ATTACHMENTS_PER_ENTRY} files may be sent at once`);
  if (new Set(value).size !== value.length) invalid("attachmentIds must not repeat");
  return value as string[];
}
/** What the user wrote; files with no text are saved as a line saying how many were sent. */
function userText(body: unknown, attachmentIds: readonly string[] | null): string {
  if (typeof body !== "string") invalid("body must be a string");
  if (body.trim().length > 0) return body;
  if (attachmentIds !== null && attachmentIds.length > 0) return `（发送了 ${attachmentIds.length} 个文件）`;
  return invalid("A reply needs text or files");
}
/** The letter's paragraph on the files, with where each is saved so the lane can read it directly. */
function fileList(files: readonly IssueAttachment[]): string[] {
  if (files.length === 0) return [];
  return [[`附件（${files.length} 个，已保存在本机，可直接读取）：`, ...files.map((file) => `- ${file.fileName}（${byteSize(file.size)}）：${file.storedPath}`)].join("\n")];
}
function byteSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const [value, unit] = size < 1024 * 1024 ? [size / 1024, "KB"] : [size / (1024 * 1024), "MB"];
  return `${value.toFixed(1).replace(/\.0$/u, "")} ${unit}`;
}
function integer(value: unknown, name: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid(`${name} must be an integer >= ${minimum}`);
  return value;
}
function pageSize(value: unknown): number {
  const size = integer(value ?? 50, "limit", 1);
  if (size > 200) invalid("limit must not exceed 200");
  return size;
}
function closeInput(input: CloseIssueInput): CloseIssueInput {
  fields(input, ["operationKey", "issueId", "body"]);
  return { operationKey: text(input.operationKey, "operationKey"), issueId: text(input.issueId, "issueId"), body: text(input.body, "body") };
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
function invalid(message: string): never { throw new IssueError("INVALID_INPUT", message); }
function reference(message: string): never { throw new IssueError("INVALID_REFERENCE", message); }
