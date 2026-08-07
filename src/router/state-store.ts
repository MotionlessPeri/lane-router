import type { RouterDatabase } from "./database.js";
import type {
  BackendName,
  BindingRecord,
  LaneRecord,
  MessageKind,
  MessageRecord,
  NewMessageRecord,
} from "./types.js";

interface LaneRow {
  address: string;
  project: string;
  role_description: string;
  created_at: number;
  updated_at: number;
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
  notification_state: "pending" | "notified";
}

export class RouterStateStore {
  constructor(readonly database: RouterDatabase) {}

  createLane(input: {
    address: string;
    project: string;
    roleDescription: string;
    now: number;
  }): LaneRecord {
    this.database.prepare(`
      INSERT INTO lane(address,project,role_description,created_at,updated_at)
      VALUES(?,?,?,?,?)
    `).run(input.address, input.project, input.roleDescription, input.now, input.now);
    return this.requireLane(input.address);
  }

  lane(address: string): LaneRecord | undefined {
    const row = this.database.prepare(`
      SELECT address,project,role_description,created_at,updated_at
      FROM lane WHERE address=?
    `).get(address) as LaneRow | undefined;
    return row ? mapLane(row) : undefined;
  }

  requireLane(address: string): LaneRecord {
    const lane = this.lane(address);
    if (!lane) throw new Error(`Lane not found: ${address}`);
    return lane;
  }

  listLanes(project: string): LaneRecord[] {
    return (this.database.prepare(`
      SELECT address,project,role_description,created_at,updated_at
      FROM lane WHERE project=? ORDER BY address
    `).all(project) as LaneRow[]).map(mapLane);
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
    try {
      this.database.prepare(`
        INSERT INTO binding(
          id,lane_address,backend,conversation_id,generation,startup_json,active_at,inactive_at
        ) VALUES(?,?,?,?,?,?,?,NULL)
      `).run(
        input.id,
        input.laneAddress,
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
    const row = this.database.prepare(`
      SELECT id,lane_address,backend,conversation_id,generation,startup_json,active_at,inactive_at
      FROM binding WHERE id=?
    `).get(id) as BindingRow | undefined;
    return row ? mapBinding(row) : undefined;
  }

  requireBinding(id: string): BindingRecord {
    const binding = this.binding(id);
    if (!binding) throw new Error(`Binding not found: ${id}`);
    return binding;
  }

  insertMessage(input: NewMessageRecord): MessageRecord {
    this.database.prepare(`
      INSERT INTO message(
        id,request_key,sender_lane,target_lane,kind,reply_to,relative_path,
        content_sha256,state,created_at,resolved_at,ack_lane,ack_generation,notification_state
      ) VALUES(?,?,?,?,?,?,?,?,'pending',?,NULL,NULL,NULL,'pending')
    `).run(
      input.id,
      input.requestKey,
      input.senderLane,
      input.targetLane,
      input.kind,
      input.replyTo,
      input.relativePath,
      input.contentSha256,
      input.createdAt,
    );
    return this.requireMessage(input.id);
  }

  message(id: string): MessageRecord | undefined {
    const row = this.database.prepare(`${MESSAGE_SELECT} WHERE id=?`).get(id) as MessageRow | undefined;
    return row ? mapMessage(row) : undefined;
  }

  requireMessage(id: string): MessageRecord {
    const message = this.message(id);
    if (!message) throw new Error(`Message not found: ${id}`);
    return message;
  }

  messageByRequestKey(requestKey: string): MessageRecord | undefined {
    const row = this.database.prepare(`${MESSAGE_SELECT} WHERE request_key=?`).get(requestKey) as MessageRow | undefined;
    return row ? mapMessage(row) : undefined;
  }

  allMessages(): MessageRecord[] {
    return (this.database.prepare(`${MESSAGE_SELECT} ORDER BY created_at,id`).all() as MessageRow[]).map(mapMessage);
  }

  markMessagesResolved(
    messageIds: readonly string[],
    input: { laneAddress: string; generation: number; now: number },
  ): void {
    const statement = this.database.prepare(`
      UPDATE message SET state='resolved',resolved_at=?,ack_lane=?,ack_generation=?
      WHERE id=? AND target_lane=? AND state='pending'
    `);
    this.database.transaction(() => {
      for (const id of messageIds) {
        if (statement.run(input.now, input.laneAddress, input.generation, id, input.laneAddress).changes !== 1) {
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

const MESSAGE_SELECT = `
  SELECT id,request_key,sender_lane,target_lane,kind,reply_to,relative_path,
    content_sha256,state,created_at,resolved_at,ack_lane,ack_generation,notification_state
  FROM message
`;

function mapLane(row: LaneRow): LaneRecord {
  return {
    address: row.address,
    project: row.project,
    roleDescription: row.role_description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
