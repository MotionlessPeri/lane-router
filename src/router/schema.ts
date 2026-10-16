import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

export const ROUTER_SCHEMA_VERSION = 11;

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
 *
 * The version 6 shape, kept verbatim for the version 5 migration, which has to produce exactly it.
 */
const MESSAGE_ARCHIVE_TABLE_V6_SQL = `
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

/**
 * Version 9: a message is sent either by a lane or from outside every lane, and the sender columns
 * say which. `sender_lane_id` stays a foreign key for lane-sent mail; `sender_label` carries
 * `user:<origin>` for mail a local program delivered on the user's behalf. There is no lane row
 * behind such a sender, deliberately — inventing one would make it read like a lane, and an
 * archived lane address can be attached to again and turned into a real lane.
 *
 * The CHECK is what keeps the two from blurring: neither column alone says who sent a message,
 * only the pair does, so exactly one of them is set on every row.
 */
const MESSAGE_TABLE_V9_SQL = `
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  sender_lane_id TEXT REFERENCES lane(id) ON DELETE RESTRICT,
  sender_label TEXT,
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
  CHECK ((sender_lane_id IS NULL) <> (sender_label IS NULL)),
  CHECK (
    (state='pending' AND resolved_at IS NULL AND ack_lane_id IS NULL AND ack_generation IS NULL) OR
    (state='resolved' AND resolved_at IS NOT NULL AND ack_lane_id IS NOT NULL AND ack_generation > 0)
  )
);
`;

/** The version 9 archive: the same sender pair as the live table, because archiving copies rows. */
const MESSAGE_ARCHIVE_TABLE_V9_SQL = `
CREATE TABLE message_archive (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL,
  sender_lane_id TEXT,
  sender_label TEXT,
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
  archived_at INTEGER NOT NULL,
  CHECK ((sender_lane_id IS NULL) <> (sender_label IS NULL))
);
`;

const BINDING_TABLE_V6_SQL = `
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
`;

/** The binding table versions 7 and 8 end in: version 7 added `dsh`, version 8 `zcode`. */
const BINDING_TABLE_V8_SQL = `
CREATE TABLE binding (
  id TEXT PRIMARY KEY,
  lane_id TEXT NOT NULL REFERENCES lane(id) ON DELETE RESTRICT,
  backend TEXT NOT NULL CHECK (backend IN ('claude','codex','dsh','zcode')),
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
`;

/**
 * Version 10: a lane set is a name and a list of lanes, kept by the Router and never on the lane
 * itself. The member table is keyed by lane, so "a lane is in at most one set" is the schema's
 * rule rather than a convention the code has to remember. Members are lanes by id, not addresses:
 * an archived address can be taken again, and the lane that takes it is not the one that was put
 * in the set. Deleting a set lets its members fall back to their projects; a lane is never deleted,
 * and membership must not become a way to try.
 */
const LANE_SET_TABLES_SQL = `
CREATE TABLE lane_set (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE lane_set_member (
  lane_id TEXT PRIMARY KEY REFERENCES lane(id) ON DELETE RESTRICT,
  set_id TEXT NOT NULL REFERENCES lane_set(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL
);
CREATE INDEX lane_set_member_set_idx ON lane_set_member(set_id);
`;

const ROUTER_SCHEMA_PREFIX = `
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
`;

/**
 * Exactly the version 6 shape, for the version 5 migration. It used to build "whatever the current
 * schema is", which was right only while the current schema was version 6; from version 7 on it
 * would have built later tables and stamped them version 6.
 */
const ROUTER_SCHEMA_V6_SQL = `${ROUTER_SCHEMA_PREFIX}${BINDING_TABLE_V6_SQL}${MESSAGE_TABLE_V6_SQL}${MESSAGE_INDEX_V6_SQL}${MESSAGE_ARCHIVE_TABLE_V6_SQL}`;

const BINDING_TABLE_V11_SQL = BINDING_TABLE_V8_SQL.replace("'claude','codex','dsh','zcode'", "'claude','codex','dsh','zcode','native-codex'");

/** Schema for newly created databases at the current version. */
export const ROUTER_SCHEMA_SQL = `${ROUTER_SCHEMA_PREFIX}${BINDING_TABLE_V11_SQL}${MESSAGE_TABLE_V9_SQL}${MESSAGE_INDEX_V6_SQL}${MESSAGE_ARCHIVE_TABLE_V9_SQL}${LANE_SET_TABLES_SQL}`;

export function initializeRouterSchema(database: Database.Database): void {
  let version = database.pragma("user_version", { simple: true }) as number;
  if (version === ROUTER_SCHEMA_VERSION) {
    assertSharedSchema(database, true);
    assertForeignKeys(database);
    return;
  }
  if (version === 0) {
    database.transaction(() => {
      database.exec(ROUTER_SCHEMA_SQL);
      database.pragma(`user_version = ${ROUTER_SCHEMA_VERSION}`);
    })();
    assertForeignKeys(database);
    return;
  }
  // Up to version 6 migrations chain: each one lifts the database exactly one version, so an old
  // database walks through every intermediate shape instead of every migration knowing every
  // starting point. Past version 6 the number stops saying what is done; see completeFromVersion6.
  if (version === 1) { migrateNotificationStateVocabulary(database); version = 2; }
  if (version === 2) { addBindingCwdColumn(database); version = 3; }
  if (version === 3) { addLaneModelColumn(database); version = 4; }
  if (version === 4) { addLaneRetiredAtColumn(database); version = 5; }
  if (version === 5) { rebuildWithLaneIdentity(database); version = 6; }
  if (version >= 6 && version < ROUTER_SCHEMA_VERSION) { completeFromVersion6(database); version = ROUTER_SCHEMA_VERSION; }
  if (version !== ROUTER_SCHEMA_VERSION) throw new Error(`Router database version ${version} is not supported`);
  assertForeignKeys(database);
}

function assertForeignKeys(database: Database.Database): void {
  if ((database.pragma("foreign_key_check") as unknown[]).length > 0) {
    throw new Error("Router database migration left dangling references; the database was not changed safely");
  }
}

/** SQL whitespace is not identity; quoted values and every structural token still are. */
function normalizedSql(sql: string): string {
  return sql.split(/('(?:''|[^'])*')/).map((part, index) => index % 2 ? part : part.replace(/\s+/g, "").toLowerCase()).join("");
}

function schemaShape(database: Database.Database): unknown {
  const objects = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  return objects.map(row => ({ ...row, sql: normalizedSql(row.name === "binding" && row.type === "table"
    ? row.sql.replace(/CHECK\s*\(\s*backend\s+IN\s*\([^)]*\)\s*\)/i, "CHECK (backend IN ('known'))") : row.sql) }));
}

/** Recognize the released branches by their structure, retaining the native migration's refusal of unknown schemas. */
function assertSharedSchema(database: Database.Database, current = false): void {
  const sql = bindingSql(database);
  const match = sql.match(/CHECK\s*\(\s*backend\s+IN\s*\(([^)]*)\)\s*\)/i);
  const values = match?.[1]?.split(",").map(value => value.trim()).sort().join(",");
  const vocabulary = (names: string[]) => names.map(name => `'${name}'`).sort().join(",");
  const base = ["claude", "codex"];
  const known = [base, [...base, "dsh"], [...base, "dsh", "zcode"], [...base, "dsh", "native-codex"], [...base, "dsh", "zcode", "native-codex"]].map(vocabulary);
  if (!values || !known.includes(values)) throw new Error("Router database schema shape is not supported");
  const labeled = messageHasSenderLabel(database);
  if (current && (!bindingAllowsEveryBackend(database) || !labeled || !hasTable(database, "lane_set"))) {
    throw new Error("Router database schema shape is not supported");
  }
  const reference = new Database(":memory:");
  try {
    reference.exec(`${ROUTER_SCHEMA_PREFIX}${BINDING_TABLE_V11_SQL}${labeled ? MESSAGE_TABLE_V9_SQL : MESSAGE_TABLE_V6_SQL}${MESSAGE_INDEX_V6_SQL}${labeled ? MESSAGE_ARCHIVE_TABLE_V9_SQL : MESSAGE_ARCHIVE_TABLE_V6_SQL}${hasTable(database, "lane_set") ? LANE_SET_TABLES_SQL : ""}`);
    if (JSON.stringify(schemaShape(database)) !== JSON.stringify(schemaShape(reference))) throw new Error("Router database schema shape is not supported");
  } finally { reference.close(); }
}

/**
 * Versions 7 to 9 were numbered on two machines at once, so from version 6 on the number does not
 * say what a database already has. One line of work used 7 and 8 for two new binding backends;
 * the other used 7 for the message sender label, which is version 9 now. A version 7 database is
 * therefore either one. Each step is decided by the shape it produces, and the number is written
 * once, when every step is in place. Version 10's lane set tables are one more step of the same
 * kind. Version 11 also admits the native Host backend from the Company branch without dropping
 * either its bindings or the main branch's sender labels and lane sets.
 *
 * One transaction for all of it: a failure anywhere leaves the database exactly as it was opened,
 * so the next start decides again from the same shape.
 *
 * 流程：
 *   1. 关外键（重建期间新表的引用对着改了名的旧表），并在事务外切换
 *   2. binding 的 CHECK 缺任一后端就按 version 11 的表重建，逐记录核对
 *   3. message 没有 sender_label 列就重建两张消息表
 *   4. 没有 lane_set 表就建两张 set 表 —— 纯加法，不碰任何已有的行
 *   5. 置当前版本并复查结构与外键完整性 —— 与 2、3、4 同一个事务，任何一步失败整体回滚
 *   6. 恢复外键开关
 */
function completeFromVersion6(database: Database.Database): void {
  assertSharedSchema(database);
  assertForeignKeys(database);
  const foreignKeysWereOn = database.pragma("foreign_keys", { simple: true }) === 1;
  database.pragma("foreign_keys = OFF");
  try {
    database.transaction(() => {
      if (!bindingAllowsEveryBackend(database)) rebuildBindingWithEveryBackend(database);
      if (!messageHasSenderLabel(database)) addMessageSenderLabel(database);
      if (!hasTable(database, "lane_set")) database.exec(LANE_SET_TABLES_SQL);
      assertSharedSchema(database, true);
      database.pragma(`user_version = ${ROUTER_SCHEMA_VERSION}`);
      assertForeignKeys(database);
    })();
  } finally {
    if (foreignKeysWereOn) database.pragma("foreign_keys = ON");
  }
}

function bindingSql(database: Database.Database): string {
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='binding'").get() as { sql: string } | undefined;
  return table?.sql ?? "";
}

function bindingAllowsEveryBackend(database: Database.Database): boolean {
  const sql = bindingSql(database);
  return ["claude", "codex", "dsh", "zcode", "native-codex"].every(backend => sql.includes(`'${backend}'`));
}

function messageHasSenderLabel(database: Database.Database): boolean {
  return (database.pragma("table_info(message)") as Array<{ name: string }>).some((column) => column.name === "sender_label");
}

function hasTable(database: Database.Database, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

/**
 * Versions 7 and 8 widen the binding backend vocabulary, first with `dsh` and then with `zcode`.
 * ZCode sessions ride the Claude channel, but a binding stored under "zcode" keeps the two
 * conversations distinguishable everywhere a (backend, conversation) pair is the key. SQLite cannot
 * alter a CHECK, so the table is rebuilt with all supported backends, including native Host.
 * Every row is compared before the old table is dropped: identity, generation and startup data
 * must survive unchanged, and matching row counts alone would miss a corrupted value.
 *
 * Runs inside the caller's transaction, with foreign keys already off.
 */
function rebuildBindingWithEveryBackend(database: Database.Database): void {
  const snapshot = () => JSON.stringify(database.prepare("SELECT * FROM binding ORDER BY id").all());
  const before = snapshot();
  database.exec("ALTER TABLE binding RENAME TO binding_legacy;");
  for (const index of ["binding_active_lane_idx", "binding_active_conversation_idx", "binding_lane_generation_idx"]) {
    database.exec(`DROP INDEX IF EXISTS ${index};`);
  }
  database.exec(BINDING_TABLE_V11_SQL);
  database.exec(`
    INSERT INTO binding(id,lane_id,backend,conversation_id,generation,startup_json,active_at,inactive_at,cwd)
    SELECT id,lane_id,backend,conversation_id,generation,startup_json,active_at,inactive_at,cwd FROM binding_legacy;
  `);
  if (snapshot() !== before) throw new Error("Router database migration changed records");
  database.exec("DROP TABLE binding_legacy;");
}

/**
 * Version 9 lets a message be sent from outside every lane. SQLite can neither drop a NOT NULL nor
 * add a CHECK to an existing table, so both message tables are rebuilt; lanes and bindings are
 * untouched. Every existing row was sent by a lane, so each arrives with its lane id and no label.
 *
 * Runs inside the caller's transaction, with foreign keys already off.
 *
 * 流程：
 *   1. 两张消息表改名让出位置，索引一并让出
 *   2. 建 version 9 的两张消息表与索引
 *   3. 逐表拷数据，sender_label 一律为空 —— 关联不涉及，但仍逐表核对行数
 *   4. 删旧表
 */
function addMessageSenderLabel(database: Database.Database): void {
  const before = { message: count(database, "message"), message_archive: count(database, "message_archive") };
  database.exec("ALTER TABLE message RENAME TO message_legacy;");
  database.exec("ALTER TABLE message_archive RENAME TO message_archive_legacy;");
  database.exec("DROP INDEX IF EXISTS message_target_state_idx;");
  database.exec(MESSAGE_TABLE_V9_SQL);
  database.exec(MESSAGE_INDEX_V6_SQL);
  database.exec(MESSAGE_ARCHIVE_TABLE_V9_SQL);

  const live = `id,request_key,sender_lane_id,target_lane_id,kind,reply_to,relative_path,
    content_sha256,state,created_at,resolved_at,ack_lane_id,ack_generation,notification_state`;
  database.exec(`INSERT INTO message(${live},sender_label) SELECT ${live},NULL FROM message_legacy;`);
  database.exec(`INSERT INTO message_archive(${live},archived_at,sender_label) SELECT ${live},archived_at,NULL FROM message_archive_legacy;`);

  const after = { message: count(database, "message"), message_archive: count(database, "message_archive") };
  for (const table of ["message", "message_archive"] as const) {
    if (after[table] !== before[table]) {
      throw new Error(`Router database migration lost rows in ${table}: ${before[table]} before, ${after[table]} after`);
    }
  }

  database.exec("DROP TABLE message_legacy;");
  database.exec("DROP TABLE message_archive_legacy;");
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
      database.exec(ROUTER_SCHEMA_V6_SQL);

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
