import { existsSync, statSync } from "node:fs";

import Database from "better-sqlite3";

/** v1 as first released. Every later version is v1 plus the UPGRADES before it, fresh or upgraded alike. */
const V1 = `
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
INSERT INTO issue_schema_version(singleton,version) VALUES(1,1);
`;

/**
 * Additions only, never a changed or dropped column, so an upgraded database is the old one plus
 * these. UPGRADES[i] takes version i+1 to i+2; its structure runs on fresh databases too, its data
 * statements only matter to existing rows.
 */
const UPGRADES: readonly { readonly structure: string; readonly data: string }[] = [
  {
    // Who ended an issue. The status-coupled CHECK still lets an ended issue with no closer through,
    // because SQLite counts a NULL result as passing: that is what lets this column be added over
    // ended v1 rows at all. The fill below leaves none, and openings check for any later.
    structure: "ALTER TABLE issue_thread ADD COLUMN closed_by TEXT CHECK((status='open' AND closed_by IS NULL) OR (status='closed' AND closed_by IN ('user','lane')))",
    // v1 could only be ended on the page or by recording the user's TUI words: by the user.
    data: "UPDATE issue_thread SET closed_by='user' WHERE status='closed'",
  },
  {
    // Files the user sends. A row is written once its file is on disk and has no entry until a
    // reply or new issue takes it; the issue and entry are set together, never one alone.
    structure: `
CREATE TABLE issue_attachment (
  id TEXT PRIMARY KEY NOT NULL,
  issue_id TEXT,
  entry_id TEXT,
  file_name TEXT NOT NULL CHECK(length(file_name)>0),
  media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/jpeg','image/gif','image/webp','application/octet-stream')),
  size INTEGER NOT NULL CHECK(typeof(size)='integer' AND size>=0),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  stored_path TEXT NOT NULL CHECK(length(stored_path)>0),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer'),
  FOREIGN KEY(issue_id,entry_id) REFERENCES issue_entry(issue_id,id) ON DELETE RESTRICT,
  CHECK((issue_id IS NULL AND entry_id IS NULL) OR (issue_id IS NOT NULL AND entry_id IS NOT NULL))
);
CREATE INDEX issue_attachment_entry_idx ON issue_attachment(issue_id,entry_id);
CREATE INDEX issue_attachment_unattached_idx ON issue_attachment(created_at) WHERE entry_id IS NULL;`,
    data: "",
  },
  {
    // Where a file stands among those its entry was sent with, so it reads in the order the user
    // added it, as the letter lists it. Set when an entry takes the file; rows from before have none
    // and read in upload order, as they always did.
    structure: "ALTER TABLE issue_attachment ADD COLUMN position INTEGER CHECK(position IS NULL OR (typeof(position)='integer' AND position>=0))",
    data: "",
  },
  {
    // The card an issue's work is on, such as LR-56; issues from before have none. An issue holds at
    // most one card and a card at most one issue: the service says so, and the index holds it anyway.
    structure: `
ALTER TABLE issue_thread ADD COLUMN task_ref TEXT;
CREATE UNIQUE INDEX issue_thread_task_ref_idx ON issue_thread(task_ref) WHERE task_ref IS NOT NULL;`,
    data: "",
  },
];

export const ISSUE_SCHEMA_VERSION = UPGRADES.length + 1;

/**
 * Validate before changing journal mode or running DDL: rejected existing files remain untouched.
 * An older version is checked against exactly what that version was, copied aside, then upgraded
 * in one transaction and checked again as the current version.
 */
export function initializeIssueSchema(database: Database.Database): void {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  const userVersion = database.pragma("user_version", { simple: true });
  const integrity = database.pragma("quick_check", { simple: true });
  if (integrity !== "ok") throw new Error(`Invalid issues database: ${String(integrity)}`);
  if (tables.length === 0 && userVersion === 0) {
    const objects = database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    if (objects.length > 0) throw new Error("Unknown nonempty issues schema");
    database.transaction(() => { database.exec(V1); upgrade(database, 1); })();
    return;
  }
  if (userVersion !== 0 || !tables.some((table) => table.name === "issue_schema_version")) throw new Error("Unknown nonempty issues schema");
  const versions = database.prepare("SELECT singleton,version FROM issue_schema_version").all() as { singleton: number; version: number }[];
  const version = versions[0]?.version;
  if (versions.length !== 1 || versions[0]?.singleton !== 1 || !Number.isInteger(version) || version! < 1 || version! > ISSUE_SCHEMA_VERSION) {
    throw new Error("Unsupported issues schema version");
  }
  requireSchema(database, version!);
  if (version! < ISSUE_SCHEMA_VERSION) {
    backUp(database, version!);
    database.transaction(() => upgrade(database, version!))();
    requireSchema(database, ISSUE_SCHEMA_VERSION);
  }
  const unattributed = database.prepare("SELECT count(*) AS count FROM issue_thread WHERE (status='closed') != (closed_by IS NOT NULL)").get() as { count: number };
  if (unattributed.count !== 0) throw new Error("Invalid issues closure facts");
}

/** Runs every upgrade after `from` and records the version reached; the caller holds the transaction. */
function upgrade(database: Database.Database, from: number): void {
  for (const step of UPGRADES.slice(from - 1)) { database.exec(step.structure); database.exec(step.data); }
  database.prepare("UPDATE issue_schema_version SET version=? WHERE singleton=1").run(ISSUE_SCHEMA_VERSION);
}

/**
 * The copy is SQLite's own, so it holds what is still only in the write-ahead log. One already
 * there is an earlier attempt's and is kept; a backup that cannot be written stops the upgrade.
 */
function backUp(database: Database.Database, version: number): void {
  if (database.memory) return;
  const target = `${database.name}.v${version}.bak`;
  if (existsSync(target) && statSync(target).isFile()) return;
  database.prepare("VACUUM INTO ?").run(target);
}

/** The objects a database of `version` has, as SQLite records them: built, not hand-written. */
const expectedSchemas = new Map<number, string>();
function expectedSchema(version: number): string {
  let schema = expectedSchemas.get(version);
  if (schema === undefined) {
    const scratch = new Database(":memory:");
    try {
      scratch.exec(V1);
      for (const step of UPGRADES.slice(0, version - 1)) scratch.exec(step.structure);
      schema = schemaOf(scratch);
    } finally { scratch.close(); }
    expectedSchemas.set(version, schema);
  }
  return schema;
}

function requireSchema(database: Database.Database, version: number): void {
  if (schemaOf(database) !== expectedSchema(version)) throw new Error("Unknown or altered issues schema");
  if ((database.pragma("foreign_key_check") as unknown[]).length !== 0) throw new Error("Invalid issues foreign keys");
}

function schemaOf(database: Database.Database): string {
  return JSON.stringify((database.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as { type: string; name: string; sql: string }[])
    .map((object) => ({ ...object, sql: normalizeSql(object.sql) })).sort((a, b) => a.name.localeCompare(b.name)));
}

function normalizeSql(sql: string): string { return sql.trim().replace(/\s+/g, " "); }
