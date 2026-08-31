import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

export const ROUTER_SCHEMA_VERSION = 6;

/**
 * The version 2 message table, kept verbatim because the version 1 migration has to build exactly
 * that shape. It is history: later versions re-point these columns at lane ids, and changing this
 * constant would make a version 1 database land somewhere no later migration knows how to lift.
 */
const MESSAGE_TABLE_SQL = `
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  sender_lane TEXT NOT NULL REFERENCES lane(address) ON DELETE RESTRICT,
  target_lane TEXT NOT NULL REFERENCES lane(address) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('normal','correction')),
  reply_to TEXT REFERENCES message(id) ON DELETE RESTRICT,
  relative_path TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','resolved')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  ack_lane TEXT REFERENCES lane(address) ON DELETE RESTRICT,
  ack_generation INTEGER,
  notification_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (notification_state IN ('pending','sent','deferred','no_channel','send_failed')),
  CHECK (
    (state='pending' AND resolved_at IS NULL AND ack_lane IS NULL AND ack_generation IS NULL) OR
    (state='resolved' AND resolved_at IS NOT NULL AND ack_lane IS NOT NULL AND ack_generation > 0)
  )
);
`;

const MESSAGE_INDEX_SQL = `
CREATE INDEX message_target_state_idx ON message(target_lane,state,created_at,id);
`;

const MESSAGE_COLUMNS = `id,request_key,sender_lane,target_lane,kind,reply_to,relative_path,
  content_sha256,state,created_at,resolved_at,ack_lane,ack_generation`;

/**
 * The live message table. Four differences from the archive table below, and every one of them is
 * the point: the three lane references are foreign keys, and `reply_to` is not.
 *
 * `reply_to` names another message, and that message really can leave — archiving moves it to the
 * archive table. A foreign key here would make archiving a message somebody replied to fail, so
 * the column stays plain text and readers tell "no reply" from "the message it answered is
 * archived" by looking. The lane references stay keys because a lane never leaves: archiving keeps
 * its row as an identity anchor precisely so these do not dangle.
 */
const MESSAGE_TABLE_V6_SQL = `
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  sender_lane_id TEXT NOT NULL REFERENCES lane(id) ON DELETE RESTRICT,
  target_lane_id TEXT NOT NULL REFERENCES lane(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('normal','correction')),
  reply_to TEXT,
  relative_path TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','resolved')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  ack_lane_id TEXT REFERENCES lane(id) ON DELETE RESTRICT,
  ack_generation INTEGER,
  notification_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (notification_state IN ('pending','sent','deferred','no_channel','send_failed')),
  CHECK (
    (state='pending' AND resolved_at IS NULL AND ack_lane_id IS NULL AND ack_generation IS NULL) OR
    (state='resolved' AND resolved_at IS NOT NULL AND ack_lane_id IS NOT NULL AND ack_generation > 0)
  )
);
`;

/**
 * Where a lane's own mail goes when it is archived: the same columns, no foreign keys at all, plus
 * when it was archived. No keys because this table is out of the working set — nothing live reads
 * it, and constraints pointing back into live tables would drag it back in.
 */
const MESSAGE_ARCHIVE_TABLE_SQL = `
CREATE TABLE message_archive (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL,
  sender_lane_id TEXT NOT NULL,
  target_lane_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  reply_to TEXT,
  relative_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  ack_lane_id TEXT,
  ack_generation INTEGER,
  notification_state TEXT NOT NULL,
  archived_at INTEGER NOT NULL
);
`;

const MESSAGE_INDEX_V6_SQL = `
CREATE INDEX message_target_state_idx ON message(target_lane_id,state,created_at,id);
`;

export const ROUTER_SCHEMA_SQL = `
CREATE TABLE lane (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  project TEXT NOT NULL,
  role_description TEXT NOT NULL CHECK (length(trim(role_description)) > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  model TEXT,
  archived_at INTEGER
);

-- An address identifies a lane only among the lanes still in service. That is what lets an
-- archived address be used again while the archived lane keeps its own row and its own history;
-- the same shape as binding_active_lane_idx below, which has guarded one active binding per lane
-- since version 1.
CREATE UNIQUE INDEX lane_live_address_idx ON lane(address) WHERE archived_at IS NULL;
CREATE INDEX lane_project_address_idx ON lane(project,address);

CREATE TABLE binding (
  id TEXT PRIMARY KEY,
  lane_id TEXT NOT NULL REFERENCES lane(id) ON DELETE RESTRICT,
  backend TEXT NOT NULL CHECK (backend IN ('claude','codex')),
  conversation_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  startup_json TEXT NOT NULL,
  active_at INTEGER NOT NULL,
  inactive_at INTEGER,
  cwd TEXT
);

CREATE UNIQUE INDEX binding_active_lane_idx
  ON binding(lane_id) WHERE inactive_at IS NULL;
CREATE UNIQUE INDEX binding_active_conversation_idx
  ON binding(backend,conversation_id) WHERE inactive_at IS NULL;
CREATE UNIQUE INDEX binding_lane_generation_idx
  ON binding(lane_id,generation);
${MESSAGE_TABLE_V6_SQL}${MESSAGE_INDEX_V6_SQL}${MESSAGE_ARCHIVE_TABLE_SQL}`;

export function initializeRouterSchema(database: Database.Database): void {
  let version = database.pragma("user_version", { simple: true }) as number;
  if (version === ROUTER_SCHEMA_VERSION) return;
  if (version === 0) {
    database.transaction(() => {
      database.exec(ROUTER_SCHEMA_SQL);
      database.pragma(`user_version = ${ROUTER_SCHEMA_VERSION}`);
    })();
    return;
  }
  // Migrations chain: each one lifts the database exactly one version, so an old database walks
  // through every intermediate shape instead of every migration knowing every starting point.
  if (version === 1) { migrateNotificationStateVocabulary(database); version = 2; }
  if (version === 2) { addBindingCwdColumn(database); version = 3; }
  if (version === 3) { addLaneModelColumn(database); version = 4; }
  if (version === 4) { addLaneRetiredAtColumn(database); version = 5; }
  if (version === 5) { rebuildWithLaneIdentity(database); version = 6; }
  if (version !== ROUTER_SCHEMA_VERSION) throw new Error(`Router database version ${version} is not supported`);
}

/**
 * Version 6 gives a lane an identity of its own and demotes its address to a label. Until now the
 * address was the primary key, so "this lane is finished with" and "this name is used up" were the
 * same fact, and a lane could only leave service by leaving a marker behind that every read had to
 * filter. With an id, an archived lane keeps its row as an anchor for the history that names it
 * while its address goes back into circulation.
 *
 * SQLite cannot alter a foreign key, and four of them change target here, so all three tables are
 * rebuilt. The `foreign_keys` dance is the one the version 1 migration already uses; it is required
 * because the new rows reference lanes that only exist in the half-built new table.
 *
 * 流程：
 *   1. 关外键（重建期间旧表与新表的引用会短暂互不认识），并在事务外切换
 *   2. 三张旧表改名让出位置，同名索引一并让出
 *   3. 建 version 6 的表与索引（含 message_archive 空表）
 *   4. 给每条 lane 发一个 id，`retired_at` 的值原样搬进 `archived_at`
 *   5. binding 与 message 按 address 关联到那些 id —— 关联失败会丢行，所以逐表核对行数
 *   6. 删旧表、置 user_version = 6
 *   7. 复查外键完整性后恢复外键开关
 */
function rebuildWithLaneIdentity(database: Database.Database): void {
  const foreignKeysWereOn = database.pragma("foreign_keys", { simple: true }) === 1;
  database.pragma("foreign_keys = OFF");
  try {
    database.transaction(() => {
      const before = {
        lane: count(database, "lane"), binding: count(database, "binding"), message: count(database, "message"),
      };
      for (const table of ["lane", "binding", "message"]) database.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy;`);
      for (const index of ["lane_project_address_idx", "binding_active_lane_idx", "binding_active_conversation_idx", "binding_lane_generation_idx", "message_target_state_idx"]) {
        database.exec(`DROP INDEX IF EXISTS ${index};`);
      }
      database.exec(ROUTER_SCHEMA_SQL);

      // One id per lane, minted here rather than in SQL so the value has the same shape as every
      // other id in this database. `retired_at` carries across untouched: those lanes left service
      // before this migration ran, and nothing here may quietly put them back.
      const insertLane = database.prepare(`
        INSERT INTO lane(id,address,project,role_description,created_at,updated_at,model,archived_at)
        VALUES(?,?,?,?,?,?,?,?)
      `);
      for (const lane of database.prepare("SELECT address,project,role_description,created_at,updated_at,model,retired_at FROM lane_legacy").all() as LegacyLaneRow[]) {
        insertLane.run(randomUUID(), lane.address, lane.project, lane.role_description, lane.created_at, lane.updated_at, lane.model, lane.retired_at);
      }

      // Addresses are unique in the table being read, so each join matches exactly one lane.
      database.exec(`
        INSERT INTO binding(id,lane_id,backend,conversation_id,generation,startup_json,active_at,inactive_at,cwd)
        SELECT b.id,l.id,b.backend,b.conversation_id,b.generation,b.startup_json,b.active_at,b.inactive_at,b.cwd
        FROM binding_legacy b JOIN lane l ON l.address=b.lane_address;
      `);
      database.exec(`
        INSERT INTO message(id,request_key,sender_lane_id,target_lane_id,kind,reply_to,relative_path,
          content_sha256,state,created_at,resolved_at,ack_lane_id,ack_generation,notification_state)
        SELECT m.id,m.request_key,s.id,t.id,m.kind,m.reply_to,m.relative_path,
          m.content_sha256,m.state,m.created_at,m.resolved_at,a.id,m.ack_generation,m.notification_state
        FROM message_legacy m
        JOIN lane s ON s.address=m.sender_lane
        JOIN lane t ON t.address=m.target_lane
        LEFT JOIN lane a ON a.address=m.ack_lane;
      `);

      // A join that fails to match drops the row rather than complaining, and a lost message is
      // exactly the loss nothing downstream could detect. Counted rather than trusted.
      const after = { lane: count(database, "lane"), binding: count(database, "binding"), message: count(database, "message") };
      for (const table of ["lane", "binding", "message"] as const) {
        if (after[table] !== before[table]) {
          throw new Error(`Router database migration lost rows in ${table}: ${before[table]} before, ${after[table]} after`);
        }
      }

      for (const table of ["lane", "binding", "message"]) database.exec(`DROP TABLE ${table}_legacy;`);
      database.pragma("user_version = 6");
    })();
    const violations = database.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error("Router database migration left dangling references; the database was not changed safely");
    }
  } finally {
    if (foreignKeysWereOn) database.pragma("foreign_keys = ON");
  }
}

interface LegacyLaneRow {
  address: string;
  project: string;
  role_description: string;
  created_at: number;
  updated_at: number;
  model: string | null;
  retired_at: number | null;
}

function count(database: Database.Database, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;
}

/**
 * Version 5 records when a lane left service. A lane cannot be deleted - its address is a primary
 * key referenced by three ON DELETE RESTRICT foreign keys, so removing the row would mean
 * destroying the message history that references it - and leaving service is what "delete" means
 * here: gone from the directory, closed to delivery, skipped by batch reopen, with every row and
 * every mailbox file untouched. NULL means in service, which is where every existing lane lands.
 *
 * The column keeps the name `retired_at` while everything above it says `archived`. That mismatch
 * is deliberate and temporary: the column is not being renamed because it is about to stop
 * existing — archiving is moving to a table of its own — and a rename shipped now would be a
 * migration that has to be carried forever to undo a word. Migrations are permanent; vocabulary
 * above the storage layer is not, so the divergence lives in `mapLane` instead.
 */
function addLaneRetiredAtColumn(database: Database.Database): void {
  database.transaction(() => {
    database.exec("ALTER TABLE lane ADD COLUMN retired_at INTEGER;");
    database.pragma("user_version = 5");
  })();
}

/**
 * Version 4 records the model a lane declares for itself, so every incarnation of that role runs
 * on the model the role calls for rather than on whatever the client defaults to. NULL means the
 * lane has declared nothing, and a lane that declares nothing is launched exactly as before.
 *
 * A declaration rather than an observation on purpose: recording what the previous conversation
 * happened to be using would carry a temporary `/model` switch into every later generation, with
 * nothing to make that visible.
 */
function addLaneModelColumn(database: Database.Database): void {
  database.transaction(() => {
    database.exec("ALTER TABLE lane ADD COLUMN model TEXT;");
    database.pragma("user_version = 4");
  })();
}

/**
 * Version 3 records the working directory a conversation last reported through its lifecycle
 * hook, so a closed lane can be resumed in the directory that owns its project context. NULL
 * means no lifecycle report has carried a cwd since the binding became active.
 */
function addBindingCwdColumn(database: Database.Database): void {
  database.transaction(() => {
    database.exec("ALTER TABLE binding ADD COLUMN cwd TEXT;");
    database.pragma("user_version = 3");
  })();
}

/**
 * Version 1 recorded a single `notified` value, written only when the outcome was `delivered`.
 * Version 2 records what actually happened, so the vocabulary in the CHECK constraint widens.
 * SQLite cannot alter a CHECK, so the table is rebuilt.
 *
 * 流程：
 *   1. 关外键（表重建期间自引用 reply_to 会短暂失去目标），并在事务外切换
 *   2. 旧表改名让出 message，同名索引一并让出
 *   3. 建 version 2 的表与索引
 *   4. 拷数据；notified 精确映射为 sent —— 它当年的含义就是「帧已写出 / turn 已开」
 *   5. 删旧表、置 user_version = 2（只抬到本迁移产出的形态，后续版本由下一段迁移接力）
 *   6. 复查外键完整性后恢复外键开关
 */
function migrateNotificationStateVocabulary(database: Database.Database): void {
  const foreignKeysWereOn = database.pragma("foreign_keys", { simple: true }) === 1;
  database.pragma("foreign_keys = OFF");
  try {
    database.transaction(() => {
      database.exec("ALTER TABLE message RENAME TO message_legacy;");
      database.exec("DROP INDEX IF EXISTS message_target_state_idx;");
      database.exec(MESSAGE_TABLE_SQL);
      database.exec(MESSAGE_INDEX_SQL);
      database.exec(`
        INSERT INTO message(${MESSAGE_COLUMNS},notification_state)
        SELECT ${MESSAGE_COLUMNS},
          CASE notification_state WHEN 'notified' THEN 'sent' ELSE notification_state END
        FROM message_legacy;
      `);
      database.exec("DROP TABLE message_legacy;");
      database.pragma("user_version = 2");
    })();
    const violations = database.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error("Router database migration left dangling references; the database was not changed safely");
    }
  } finally {
    if (foreignKeysWereOn) database.pragma("foreign_keys = ON");
  }
}
