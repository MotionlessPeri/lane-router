import type Database from "better-sqlite3";

export const ISSUE_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE issue_thread (
  id TEXT PRIMARY KEY NOT NULL,
  owner_lane_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(trim(title))>0),
  origin_kind TEXT NOT NULL CHECK(origin_kind IN ('answer','question')),
  status TEXT NOT NULL CHECK(status IN ('open','closed')),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer'),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer'),
  closed_at INTEGER CHECK(closed_at IS NULL OR typeof(closed_at)='integer'),
  read_seq INTEGER NOT NULL CHECK(typeof(read_seq)='integer' AND read_seq>=0),
  next_seq INTEGER NOT NULL CHECK(typeof(next_seq)='integer' AND next_seq>read_seq),
  UNIQUE(id,owner_lane_id),
  CHECK((status='open' AND closed_at IS NULL) OR (status='closed' AND closed_at IS NOT NULL))
);
CREATE INDEX issue_thread_owner_updated_idx ON issue_thread(owner_lane_id,updated_at DESC,id DESC);
CREATE TABLE issue_entry (
  id TEXT PRIMARY KEY NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issue_thread(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq>0),
  kind TEXT NOT NULL CHECK(kind IN ('question','answer','reply','event')),
  author TEXT NOT NULL CHECK(author IN ('lane','user')),
  source TEXT NOT NULL CHECK(source IN ('agent','user_page','agent_reported_tui_user')),
  body TEXT NOT NULL CHECK(length(trim(body))>0),
  related_entry_id TEXT,
  recorded_by_binding_id TEXT,
  recorded_by_generation INTEGER,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer'),
  UNIQUE(issue_id,seq),
  UNIQUE(issue_id,id),
  FOREIGN KEY(issue_id,related_entry_id) REFERENCES issue_entry(issue_id,id) ON DELETE RESTRICT,
  CHECK((recorded_by_binding_id IS NULL AND recorded_by_generation IS NULL) OR
    (recorded_by_binding_id IS NOT NULL AND typeof(recorded_by_generation)='integer' AND recorded_by_generation>0))
);
CREATE TABLE issue_question (
  id TEXT PRIMARY KEY NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issue_thread(id) ON DELETE RESTRICT,
  prompt_entry_id TEXT NOT NULL UNIQUE,
  asked_to TEXT NOT NULL CHECK(asked_to IN ('user','lane')),
  status TEXT NOT NULL CHECK(status IN ('waiting_user','waiting_lane','answered','not_needed')),
  answer_entry_id TEXT,
  reason TEXT,
  FOREIGN KEY(issue_id,prompt_entry_id) REFERENCES issue_entry(issue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(issue_id,answer_entry_id) REFERENCES issue_entry(issue_id,id) ON DELETE RESTRICT,
  CHECK((status='answered' AND answer_entry_id IS NOT NULL AND reason IS NULL) OR
    (status='not_needed' AND answer_entry_id IS NULL AND reason IS NOT NULL AND length(trim(reason))>0) OR
    (status IN ('waiting_user','waiting_lane') AND answer_entry_id IS NULL AND reason IS NULL))
);
CREATE INDEX issue_question_status_idx ON issue_question(issue_id,status);
CREATE TABLE issue_delivery (
  id TEXT PRIMARY KEY NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issue_thread(id) ON DELETE RESTRICT,
  entry_id TEXT NOT NULL UNIQUE,
  owner_lane_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(trim(body))>0),
  source_kind TEXT NOT NULL CHECK(source_kind='user'),
  source_origin TEXT NOT NULL CHECK(source_origin='issues'),
  request_key TEXT NOT NULL UNIQUE,
  handoff_state TEXT NOT NULL CHECK(handoff_state IN ('pending','accepted','blocked')),
  core_message_id TEXT,
  attempt_count INTEGER NOT NULL CHECK(typeof(attempt_count)='integer' AND attempt_count>=0),
  next_attempt_at INTEGER NOT NULL CHECK(typeof(next_attempt_at)='integer'),
  last_error TEXT,
  last_target_state TEXT,
  processed_at INTEGER,
  processed_by_binding_id TEXT,
  processed_by_generation INTEGER,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer'),
  FOREIGN KEY(issue_id,entry_id) REFERENCES issue_entry(issue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(issue_id,owner_lane_id) REFERENCES issue_thread(id,owner_lane_id) ON DELETE RESTRICT,
  CHECK(handoff_state!='accepted' OR (core_message_id IS NOT NULL AND length(core_message_id)>0)),
  CHECK((processed_at IS NULL AND processed_by_binding_id IS NULL AND processed_by_generation IS NULL) OR
    (typeof(processed_at)='integer' AND processed_by_binding_id IS NOT NULL AND typeof(processed_by_generation)='integer' AND processed_by_generation>0))
);
CREATE INDEX issue_delivery_pending_idx ON issue_delivery(handoff_state,next_attempt_at);
CREATE TABLE issue_operation (
  actor_scope TEXT NOT NULL,
  operation TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer'),
  PRIMARY KEY(actor_scope,operation,operation_key)
);
CREATE TABLE issue_schema_version (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>0)
);
INSERT INTO issue_schema_version(singleton,version) VALUES(1,${ISSUE_SCHEMA_VERSION});
`;

const TABLES = ["issue_delivery", "issue_entry", "issue_operation", "issue_question", "issue_schema_version", "issue_thread"];

/** Validate before changing journal mode or running DDL: rejected existing files remain untouched. */
export function initializeIssueSchema(database: Database.Database): void {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  const userVersion = database.pragma("user_version", { simple: true });
  const integrity = database.pragma("quick_check", { simple: true });
  if (integrity !== "ok") throw new Error(`Invalid issues database: ${String(integrity)}`);
  if (tables.length === 0 && userVersion === 0) {
    const objects = database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    if (objects.length > 0) throw new Error("Unknown nonempty issues schema");
    database.transaction(() => database.exec(SCHEMA))();
    return;
  }
  if (userVersion !== 0 || JSON.stringify(tables.map((table) => table.name)) !== JSON.stringify(TABLES)) {
    throw new Error("Unknown nonempty issues schema");
  }
  const versions = database.prepare("SELECT singleton,version FROM issue_schema_version").all() as { singleton: number; version: number }[];
  if (versions.length !== 1 || versions[0]?.singleton !== 1 || versions[0]?.version !== ISSUE_SCHEMA_VERSION) {
    throw new Error("Unsupported issues schema version");
  }
  const expected = SCHEMA.split(";").flatMap((statement) => {
    const sql = normalizeSql(statement);
    const match = /^CREATE (TABLE|INDEX) ([a-z_]+)/.exec(sql);
    return match ? [{ type: match[1]!.toLowerCase(), name: match[2]!, sql }] : [];
  }).sort((a, b) => a.name.localeCompare(b.name));
  const actual = (database.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as { type: string; name: string; sql: string }[])
    .map((object) => ({ ...object, sql: normalizeSql(object.sql) })).sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Unknown or altered issues schema");
  if ((database.pragma("foreign_key_check") as unknown[]).length !== 0) throw new Error("Invalid issues foreign keys");
}

function normalizeSql(sql: string): string { return sql.trim().replace(/\s+/g, " "); }
