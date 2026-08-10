import type Database from "better-sqlite3";

export const ROUTER_SCHEMA_VERSION = 2;

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

export const ROUTER_SCHEMA_SQL = `
CREATE TABLE lane (
  address TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  role_description TEXT NOT NULL CHECK (length(trim(role_description)) > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX lane_project_address_idx ON lane(project,address);

CREATE TABLE binding (
  id TEXT PRIMARY KEY,
  lane_address TEXT NOT NULL REFERENCES lane(address) ON DELETE RESTRICT,
  backend TEXT NOT NULL CHECK (backend IN ('claude','codex')),
  conversation_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  startup_json TEXT NOT NULL,
  active_at INTEGER NOT NULL,
  inactive_at INTEGER
);

CREATE UNIQUE INDEX binding_active_lane_idx
  ON binding(lane_address) WHERE inactive_at IS NULL;
CREATE UNIQUE INDEX binding_active_conversation_idx
  ON binding(backend,conversation_id) WHERE inactive_at IS NULL;
CREATE UNIQUE INDEX binding_lane_generation_idx
  ON binding(lane_address,generation);
${MESSAGE_TABLE_SQL}${MESSAGE_INDEX_SQL}`;

export function initializeRouterSchema(database: Database.Database): void {
  const version = database.pragma("user_version", { simple: true }) as number;
  if (version === ROUTER_SCHEMA_VERSION) return;
  if (version === 0) {
    database.transaction(() => {
      database.exec(ROUTER_SCHEMA_SQL);
      database.pragma(`user_version = ${ROUTER_SCHEMA_VERSION}`);
    })();
    return;
  }
  if (version === 1) {
    migrateNotificationStateVocabulary(database);
    return;
  }
  throw new Error(`Router database version ${version} is not supported`);
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
 *   5. 删旧表、置 user_version
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
      database.pragma(`user_version = ${ROUTER_SCHEMA_VERSION}`);
    })();
    const violations = database.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error("Router database migration left dangling references; the database was not changed safely");
    }
  } finally {
    if (foreignKeysWereOn) database.pragma("foreign_keys = ON");
  }
}
