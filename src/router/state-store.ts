import { randomUUID } from "node:crypto";

import type { RouterDatabase } from "./database.js";
import type {
  BackendName,
  BindingRecord,
  LaneRecord,
  MessageKind,
  MessageRecord,
  NewMessageRecord,
  NotificationOutcome,
  NotificationState,
} from "./types.js";

interface LaneRow {
  id: string;
  address: string;
  project: string;
  role_description: string;
  created_at: number;
  updated_at: number;
  model: string | null;
  archived_at: number | null;
}

interface BindingRow {
  id: string;
  lane_address: string;
  backend: BackendName;
  conversation_id: string;
  generation: number;
  startup_json: string;
  active_at: number;
  inactive_at: number | null;
  cwd: string | null;
}

interface MessageRow {
  id: string;
  request_key: string;
  sender_lane: string;
  target_lane: string;
  kind: MessageKind;
  reply_to: string | null;
  relative_path: string;
  content_sha256: string;
  state: "pending" | "resolved";
  created_at: number;
  resolved_at: number | null;
  ack_lane: string | null;
  ack_generation: number | null;
  notification_state: NotificationState;
}

export class RouterStateStore {
  constructor(readonly database: RouterDatabase) {}

  createLane(input: {
    address: string;
    project: string;
    roleDescription: string;
    now: number;
    model?: string;
  }): LaneRecord {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO lane(id,address,project,role_description,created_at,updated_at,model)
      VALUES(?,?,?,?,?,?,?)
    `).run(id, input.address, input.project, input.roleDescription, input.now, input.now, input.model ?? null);
    return this.requireLaneById(id);
  }

  /**
   * The lane currently answering to this address — never an archived one. An address identifies a
   * lane only while that lane is in service; after archiving it can belong to a different lane
   * entirely, so a lookup that returned the archived row would be answering about the wrong lane.
   * Reaching an archived lane is done by id, which is what the history holds.
   */
  lane(address: string): LaneRecord | undefined {
    const row = this.database.prepare(`
      ${LANE_SELECT} WHERE address=? AND archived_at IS NULL
    `).get(address) as LaneRow | undefined;
    return row ? mapLane(row) : undefined;
  }

  requireLane(address: string): LaneRecord {
    const lane = this.lane(address);
    if (!lane) throw new Error(`Lane not found: ${address}`);
    return lane;
  }

  /**
   * The most recently archived lane that answered to this address, if any. Not an identity lookup —
   * `lane` is that, and it deliberately never returns an archived row — but the answer to "there is
   * nothing here now; was there?", which is what makes a refusal or a skip say something useful
   * instead of just "not found". Most recent, because an address can be used and archived more
   * than once.
   */
  archivedLaneAt(address: string): LaneRecord | undefined {
    const row = this.database.prepare(`
      ${LANE_SELECT} WHERE address=? AND archived_at IS NOT NULL ORDER BY archived_at DESC,id DESC LIMIT 1
    `).get(address) as LaneRow | undefined;
    return row ? mapLane(row) : undefined;
  }

  /** By identity rather than by name, so it finds a lane whether or not it is still in service. */
  laneById(id: string): LaneRecord | undefined {
    const row = this.database.prepare(`${LANE_SELECT} WHERE id=?`).get(id) as LaneRow | undefined;
    return row ? mapLane(row) : undefined;
  }

  requireLaneById(id: string): LaneRecord {
    const lane = this.laneById(id);
    if (!lane) throw new Error(`Lane not found: ${id}`);
    return lane;
  }

  listLanes(project: string): LaneRecord[] {
    return (this.database.prepare(`
      ${LANE_SELECT} WHERE project=? AND archived_at IS NULL ORDER BY address
    `).all(project) as LaneRow[]).map(mapLane);
  }

  /**
   * The declaration is written verbatim: no allow-list of model names. Such a list goes stale as
   * models are added, and a stale one rejects the models that actually exist - a worse failure
   * than passing an unknown name to the CLI, which reports it precisely.
   */
  updateLaneModel(address: string, model: string, now: number): LaneRecord {
    if (!model.trim()) throw new Error("Model is required");
    if (this.database.prepare(`
      UPDATE lane SET model=?,updated_at=? WHERE address=? AND archived_at IS NULL
    `).run(model, now, address).changes !== 1) throw new Error(`Lane not found: ${address}`);
    return this.requireLane(address);
  }

  /**
   * Archiving takes a lane out of service without taking it out of the record: the row stays as
   * the identity every earlier message points at, and its address goes back into circulation the
   * moment this returns — the live-address index only constrains lanes still in service.
   *
   * There is no way back, by decision rather than by omission. A returned lane would have to
   * re-take an address that may already belong to someone else, and the history that named it
   * would silently start meaning the other one. A role that is needed again is a new lane.
   */
  archiveLane(address: string, now: number): LaneRecord {
    const lane = this.requireLane(address);
    this.database.prepare("UPDATE lane SET archived_at=?,updated_at=? WHERE id=?").run(now, now, lane.id);
    return this.requireLaneById(lane.id);
  }

  /** The archived ones, which `listLanes` deliberately no longer returns. All projects when omitted. */
  listArchivedLanes(project: string | undefined): LaneRecord[] {
    const rows = project === undefined
      ? this.database.prepare(`${LANE_SELECT} WHERE archived_at IS NOT NULL ORDER BY address`).all()
      : this.database.prepare(`${LANE_SELECT} WHERE project=? AND archived_at IS NOT NULL ORDER BY address`).all(project);
    return (rows as LaneRow[]).map(mapLane);
  }

  /**
   * Every lane this Router knows, across all projects and whether or not it is still in service.
   * `listLanes` deliberately answers neither question — it takes a project and hides the archived —
   * and both of those are what makes "where did that lane go" unanswerable in one look today.
   */
  listAllLanes(): LaneRecord[] {
    return (this.database.prepare(`${LANE_SELECT} ORDER BY address`).all() as LaneRow[]).map(mapLane);
  }

  /**
   * The newest messages first, at most `limit` of them. Deliberately not `allMessages()`: that one
   * loads every row ever written, which is what a long-lived Router accumulates most of.
   */
  recentMessages(limit: number): MessageRecord[] {
    return (this.database.prepare(`${MESSAGE_SELECT}
      ORDER BY m.created_at DESC,m.id DESC LIMIT ?
    `).all(limit) as MessageRow[]).map(mapMessage);
  }

  countMessages(): number {
    return (this.database.prepare("SELECT COUNT(*) AS total FROM message").get() as { total: number }).total;
  }

  /** How much each lane is behind, in one query rather than one query per lane. */
  pendingBacklog(): Array<{ laneAddress: string; count: number; oldestCreatedAt: number }> {
    return (this.database.prepare(`
      SELECT l.address AS target_lane,COUNT(*) AS total,MIN(m.created_at) AS oldest
      FROM message m JOIN lane l ON l.id=m.target_lane_id
      WHERE m.state='pending' GROUP BY m.target_lane_id,l.address
    `).all() as Array<{ target_lane: string; total: number; oldest: number }>)
      .map((row) => ({ laneAddress: row.target_lane, count: row.total, oldestCreatedAt: row.oldest }));
  }

  updateLaneRole(address: string, roleDescription: string, now: number): LaneRecord {
    if (!roleDescription.trim()) throw new Error("Role description is required");
    if (this.database.prepare(`
      UPDATE lane SET role_description=?,updated_at=? WHERE address=? AND archived_at IS NULL
    `).run(roleDescription, now, address).changes !== 1) throw new Error(`Lane not found: ${address}`);
    return this.requireLane(address);
  }

  createBinding(input: {
    id: string;
    laneAddress: string;
    backend: BackendName;
    conversationId: string;
    generation: number;
    startup: Readonly<Record<string, unknown>>;
    now: number;
  }): BindingRecord {
    // Resolved to the lane in service at this address: a binding belongs to a lane, and after
    // archiving the same address can name a different one.
    const laneId = this.requireLane(input.laneAddress).id;
    try {
      this.database.prepare(`
        INSERT INTO binding(
          id,lane_id,backend,conversation_id,generation,startup_json,active_at,inactive_at
        ) VALUES(?,?,?,?,?,?,?,NULL)
      `).run(
        input.id,
        laneId,
        input.backend,
        input.conversationId,
        input.generation,
        JSON.stringify(input.startup),
        input.now,
      );
    } catch (error) {
      if (error instanceof Error && /unique constraint/iu.test(error.message)) {
        throw new Error("An active binding already exists for this lane or conversation");
      }
      throw error;
    }
    return this.requireBinding(input.id);
  }

  binding(id: string): BindingRecord | undefined {
    const row = this.database.prepare(`${BINDING_SELECT} WHERE b.id=?`).get(id) as BindingRow | undefined;
    return row ? mapBinding(row) : undefined;
  }

  requireBinding(id: string): BindingRecord {
    const binding = this.binding(id);
    if (!binding) throw new Error(`Binding not found: ${id}`);
    return binding;
  }

  activeBindingForLane(laneAddress: string): BindingRecord | undefined {
    const row = this.database.prepare(`${BINDING_SELECT}
      WHERE l.address=? AND l.archived_at IS NULL AND b.inactive_at IS NULL
    `).get(laneAddress) as BindingRow | undefined;
    return row ? mapBinding(row) : undefined;
  }

  /** By identity, so it still answers for an archived lane — which by address is unreachable. */
  activeBindingForLaneId(laneId: string): BindingRecord | undefined {
    const row = this.database.prepare(`${BINDING_SELECT}
      WHERE b.lane_id=? AND b.inactive_at IS NULL
    `).get(laneId) as BindingRow | undefined;
    return row ? mapBinding(row) : undefined;
  }

  activeBindingForConversation(backend: BackendName, conversationId: string): BindingRecord | undefined {
    const row = this.database.prepare(`${BINDING_SELECT}
      WHERE b.backend=? AND b.conversation_id=? AND b.inactive_at IS NULL
    `).get(backend, conversationId) as BindingRow | undefined;
    return row ? mapBinding(row) : undefined;
  }

  latestBindingForConversation(backend: BackendName, conversationId: string): BindingRecord | undefined {
    const row = this.database.prepare(`${BINDING_SELECT}
      WHERE b.backend=? AND b.conversation_id=? ORDER BY b.active_at DESC,b.id DESC LIMIT 1
    `).get(backend, conversationId) as BindingRow | undefined;
    return row ? mapBinding(row) : undefined;
  }

  activeBindings(backend?: BackendName): BindingRecord[] {
    const rows = backend === undefined
      ? this.database.prepare(`${BINDING_SELECT} WHERE b.inactive_at IS NULL ORDER BY l.address`).all()
      : this.database.prepare(`${BINDING_SELECT} WHERE b.inactive_at IS NULL AND b.backend=? ORDER BY l.address`).all(backend);
    return (rows as BindingRow[]).map(mapBinding);
  }

  /**
   * The latest lifecycle-reported working directory for a conversation. Only the active binding
   * receives reports: an inactive one keeps the cwd it had, as a record of where it actually ran.
   * A conversation without an active binding has nowhere to record the fact, so it is dropped.
   */
  updateBindingCwd(backend: BackendName, conversationId: string, cwd: string): void {
    this.database.prepare(`
      UPDATE binding SET cwd=? WHERE backend=? AND conversation_id=? AND inactive_at IS NULL
    `).run(cwd, backend, conversationId);
  }

  deactivateBinding(id: string, generation: number, now: number): boolean {
    return this.database.prepare(`
      UPDATE binding SET inactive_at=? WHERE id=? AND generation=? AND inactive_at IS NULL
    `).run(now, id, generation).changes === 1;
  }

  replaceBinding(input: {
    expected: Pick<BindingRecord, "id" | "generation"> | null;
    id: string;
    laneAddress: string;
    backend: BackendName;
    conversationId: string;
    generation: number;
    startup: Readonly<Record<string, unknown>>;
    roleDescription?: string;
    model?: string;
    now: number;
  }): BindingRecord | undefined {
    return this.database.transaction(() => {
      const current = this.activeBindingForLane(input.laneAddress);
      if (input.expected === null) {
        if (current) return undefined;
      } else if (current?.id !== input.expected.id || current.generation !== input.expected.generation) {
        return undefined;
      } else if (!this.deactivateBinding(input.expected.id, input.expected.generation, input.now)) {
        return undefined;
      }
      if (input.roleDescription !== undefined) this.updateLaneRole(input.laneAddress, input.roleDescription, input.now);
      if (input.model !== undefined) this.updateLaneModel(input.laneAddress, input.model, input.now);
      return this.createBinding(input);
    })();
  }

  insertMessage(input: NewMessageRecord): MessageRecord {
    // Both ends are resolved to the lanes in service now. A message is addressed to whoever holds
    // the address at the moment it is sent, and it goes on naming that lane afterwards even once
    // the address has moved on.
    const senderId = this.requireLane(input.senderLane).id;
    const targetId = this.requireLane(input.targetLane).id;
    this.database.prepare(`
      INSERT INTO message(
        id,request_key,sender_lane_id,target_lane_id,kind,reply_to,relative_path,
        content_sha256,state,created_at,resolved_at,ack_lane_id,ack_generation,notification_state
      ) VALUES(?,?,?,?,?,?,?,?,'pending',?,NULL,NULL,NULL,'pending')
    `).run(
      input.id,
      input.requestKey,
      senderId,
      targetId,
      input.kind,
      input.replyTo,
      input.relativePath,
      input.contentSha256,
      input.createdAt,
    );
    return this.requireMessage(input.id);
  }

  message(id: string): MessageRecord | undefined {
    const row = this.database.prepare(`${MESSAGE_SELECT} WHERE m.id=?`).get(id) as MessageRow | undefined;
    return row ? mapMessage(row) : undefined;
  }

  requireMessage(id: string): MessageRecord {
    const message = this.message(id);
    if (!message) throw new Error(`Message not found: ${id}`);
    return message;
  }

  messageByRequestKey(requestKey: string): MessageRecord | undefined {
    const row = this.database.prepare(`${MESSAGE_SELECT} WHERE m.request_key=?`).get(requestKey) as MessageRow | undefined;
    return row ? mapMessage(row) : undefined;
  }

  allMessages(): MessageRecord[] {
    return (this.database.prepare(`${MESSAGE_SELECT} ORDER BY m.created_at,m.id`).all() as MessageRow[]).map(mapMessage);
  }

  pendingMessages(laneAddress: string): MessageRecord[] {
    return (this.database.prepare(`${MESSAGE_SELECT}
      WHERE t.address=? AND t.archived_at IS NULL AND m.state='pending' ORDER BY m.created_at,m.id
    `).all(laneAddress) as MessageRow[]).map(mapMessage);
  }

  /** By identity, so the precondition still answers for a lane its address no longer names. */
  pendingMessagesByLaneId(laneId: string): MessageRecord[] {
    return (this.database.prepare(`${MESSAGE_SELECT}
      WHERE m.target_lane_id=? AND m.state='pending' ORDER BY m.created_at,m.id
    `).all(laneId) as MessageRow[]).map(mapMessage);
  }

  /** What this lane's archive holds, so a half-moved file set can be finished without guessing. */
  archivedMessagesForLane(laneId: string): Array<{ id: string; relativePath: string }> {
    return (this.database.prepare(
      "SELECT id,relative_path FROM message_archive WHERE target_lane_id=? ORDER BY created_at,id",
    ).all(laneId) as Array<{ id: string; relative_path: string }>)
      .map((row) => ({ id: row.id, relativePath: row.relative_path }));
  }

  pendingLaneAddresses(): string[] {
    return (this.database.prepare(`
      SELECT DISTINCT t.address AS target_lane FROM message m
      JOIN lane t ON t.id=m.target_lane_id
      WHERE m.state='pending' ORDER BY t.address
    `).all() as Array<{ target_lane: string }>).map((row) => row.target_lane);
  }

  /**
   * Move a lane's own mail out of the working set: the rows it received, with their files still to
   * follow. Deliberately by lane id — an archived lane cannot be reached by address any more, and
   * this is called as part of archiving it.
   *
   * The rows it *sent* are not touched. Those live in other lanes' mailboxes and belong to them;
   * their `sender_lane_id` keeps pointing at the row this lane leaves behind.
   */
  archiveLaneMessages(laneId: string, now: number): MessageRecord[] {
    return this.database.transaction(() => {
      const moving = (this.database.prepare(`${MESSAGE_SELECT} WHERE m.target_lane_id=? ORDER BY m.created_at,m.id`)
        .all(laneId) as MessageRow[]).map(mapMessage);
      this.database.prepare(`
        INSERT INTO message_archive(id,request_key,sender_lane_id,target_lane_id,kind,reply_to,relative_path,
          content_sha256,state,created_at,resolved_at,ack_lane_id,ack_generation,notification_state,archived_at)
        SELECT id,request_key,sender_lane_id,target_lane_id,kind,reply_to,relative_path,
          content_sha256,state,created_at,resolved_at,ack_lane_id,ack_generation,notification_state,?
        FROM message WHERE target_lane_id=?
      `).run(now, laneId);
      this.database.prepare("DELETE FROM message WHERE target_lane_id=?").run(laneId);
      return moving;
    })();
  }

  /**
   * Whether this id names a message that has been archived, which is not the same as unknown. The
   * lane comes with it because the only caller — repairing a half-finished archive — needs to know
   * which lane's archive the file belongs in, and asking twice could get two different answers.
   */
  archivedMessage(id: string): { id: string; relativePath: string; targetLaneId: string } | undefined {
    const row = this.database.prepare("SELECT id,relative_path,target_lane_id FROM message_archive WHERE id=?")
      .get(id) as { id: string; relative_path: string; target_lane_id: string } | undefined;
    return row ? { id: row.id, relativePath: row.relative_path, targetLaneId: row.target_lane_id } : undefined;
  }

  updateArchivedMessagePath(id: string, relativePath: string): void {
    if (this.database.prepare("UPDATE message_archive SET relative_path=? WHERE id=?").run(relativePath, id).changes !== 1) {
      throw new Error(`Archived message not found: ${id}`);
    }
  }

  recordNotificationOutcome(messageIds: readonly string[], outcome: NotificationOutcome): void {
    const statement = this.database.prepare(`
      UPDATE message SET notification_state=? WHERE id=? AND state='pending'
    `);
    this.database.transaction(() => {
      for (const id of messageIds) statement.run(outcome, id);
    })();
  }

  markMessagesResolved(
    messageIds: readonly string[],
    input: { laneAddress: string; generation: number; now: number },
  ): void {
    const laneId = this.requireLane(input.laneAddress).id;
    const statement = this.database.prepare(`
      UPDATE message SET state='resolved',resolved_at=?,ack_lane_id=?,ack_generation=?
      WHERE id=? AND target_lane_id=? AND state='pending'
    `);
    this.database.transaction(() => {
      for (const id of messageIds) {
        if (statement.run(input.now, laneId, input.generation, id, laneId).changes !== 1) {
          throw new Error(`Message cannot be resolved by lane: ${id}`);
        }
      }
    })();
  }

  updateMessagePath(id: string, relativePath: string): void {
    if (this.database.prepare("UPDATE message SET relative_path=? WHERE id=?").run(relativePath, id).changes !== 1) {
      throw new Error(`Message not found: ${id}`);
    }
  }
}

const LANE_SELECT = `
  SELECT id,address,project,role_description,created_at,updated_at,model,archived_at
  FROM lane
`;

/**
 * Lanes are stored by id and read back by address: the join is what keeps every caller above this
 * file working in addresses, which is what a person types and what a mailbox path is made of.
 * An archived lane still resolves here — its row is still there — so history reads correctly.
 */
const BINDING_SELECT = `
  SELECT b.id,l.address AS lane_address,b.backend,b.conversation_id,b.generation,
    b.startup_json,b.active_at,b.inactive_at,b.cwd
  FROM binding b JOIN lane l ON l.id=b.lane_id
`;

const MESSAGE_SELECT = `
  SELECT m.id,m.request_key,s.address AS sender_lane,t.address AS target_lane,m.kind,m.reply_to,
    m.relative_path,m.content_sha256,m.state,m.created_at,m.resolved_at,
    a.address AS ack_lane,m.ack_generation,m.notification_state
  FROM message m
  JOIN lane s ON s.id=m.sender_lane_id
  JOIN lane t ON t.id=m.target_lane_id
  LEFT JOIN lane a ON a.id=m.ack_lane_id
`;

function mapLane(row: LaneRow): LaneRecord {
  return {
    id: row.id,
    address: row.address,
    project: row.project,
    roleDescription: row.role_description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    model: row.model,
    archivedAt: row.archived_at,
  };
}

function mapBinding(row: BindingRow): BindingRecord {
  return {
    id: row.id,
    laneAddress: row.lane_address,
    backend: row.backend,
    conversationId: row.conversation_id,
    generation: row.generation,
    startup: JSON.parse(row.startup_json) as Record<string, unknown>,
    activeAt: row.active_at,
    inactiveAt: row.inactive_at,
    cwd: row.cwd,
  };
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    requestKey: row.request_key,
    senderLane: row.sender_lane,
    targetLane: row.target_lane,
    kind: row.kind,
    replyTo: row.reply_to,
    relativePath: row.relative_path,
    contentSha256: row.content_sha256,
    state: row.state,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    ackLane: row.ack_lane,
    ackGeneration: row.ack_generation,
    notificationState: row.notification_state,
  };
}
