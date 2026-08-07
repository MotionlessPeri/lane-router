import type Database from "better-sqlite3";

const MIGRATION_V1 = `
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  manifest_identity TEXT NOT NULL,
  manifest_version INTEGER NOT NULL CHECK (manifest_version > 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  local_root TEXT NOT NULL UNIQUE,
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE workspace_relink (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  old_root TEXT NOT NULL,
  new_root TEXT NOT NULL,
  relinked_at INTEGER NOT NULL
);

CREATE TABLE lane (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  role_document TEXT NOT NULL,
  communication_entry INTEGER NOT NULL CHECK (communication_entry IN (0, 1)),
  UNIQUE(project_id, name)
);

CREATE TABLE binding (
  id TEXT PRIMARY KEY,
  lane_id TEXT NOT NULL REFERENCES lane(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  adapter TEXT NOT NULL CHECK (adapter IN ('claude', 'codex')),
  conversation_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  active_at INTEGER NOT NULL,
  inactive_at INTEGER,
  inactive_reason TEXT,
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  CHECK (
    (is_current = 1 AND inactive_at IS NULL AND inactive_reason IS NULL) OR
    (is_current = 0 AND inactive_at IS NOT NULL AND inactive_reason IS NOT NULL)
  ),
  UNIQUE(lane_id, generation)
);
CREATE UNIQUE INDEX binding_one_current_per_lane
  ON binding(lane_id) WHERE is_current = 1;
CREATE TRIGGER binding_generation_must_advance
BEFORE INSERT ON binding
WHEN NEW.generation <= COALESCE((
  SELECT MAX(generation) FROM binding WHERE lane_id = NEW.lane_id
), 0)
BEGIN
  SELECT RAISE(ABORT, 'binding generation must advance');
END;

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  sender_binding_id TEXT NOT NULL REFERENCES binding(id) ON DELETE RESTRICT,
  target_lane_id TEXT NOT NULL REFERENCES lane(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('normal', 'correction')),
  body TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  reply_to TEXT REFERENCES message(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL
);

CREATE TABLE delivery (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
  target_lane_id TEXT NOT NULL REFERENCES lane(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'notified', 'claimed', 'acknowledged', 'parked')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  deadline_kind TEXT CHECK (deadline_kind IN ('claim', 'queue', 'lease')),
  deadline_at INTEGER,
  next_attempt_at INTEGER,
  last_error TEXT,
  adapter_result TEXT CHECK (adapter_result IN ('started_new_turn', 'applied_current_turn', 'queued_next_turn')),
  park_reason TEXT,
  updated_at INTEGER,
  UNIQUE(message_id, target_lane_id),
  UNIQUE(target_lane_id, sequence),
  CHECK ((deadline_kind IS NULL) = (deadline_at IS NULL)),
  CHECK (
    (state = 'pending' AND deadline_kind IS NULL AND adapter_result IS NULL AND park_reason IS NULL) OR
    (state = 'notified' AND deadline_kind IN ('claim', 'queue') AND adapter_result IS NOT NULL AND next_attempt_at IS NULL AND park_reason IS NULL) OR
    (state = 'claimed' AND deadline_kind = 'lease' AND adapter_result IS NULL AND next_attempt_at IS NULL AND park_reason IS NULL) OR
    (state = 'acknowledged' AND deadline_kind IS NULL AND adapter_result IS NULL AND next_attempt_at IS NULL AND park_reason IS NULL) OR
    (state = 'parked' AND deadline_kind IS NULL AND adapter_result IS NULL AND next_attempt_at IS NULL AND park_reason IS NOT NULL)
  )
);

CREATE TABLE claim (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES delivery(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  lease_deadline_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT
);
CREATE UNIQUE INDEX claim_one_active_per_delivery
  ON claim(delivery_id) WHERE closed_at IS NULL;

CREATE TABLE ack (
  delivery_id TEXT PRIMARY KEY REFERENCES delivery(id) ON DELETE RESTRICT,
  claim_id TEXT NOT NULL REFERENCES claim(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('replied', 'recorded', 'rejected')),
  outcome_payload_json TEXT NOT NULL CHECK (json_valid(outcome_payload_json)),
  acknowledged_at INTEGER NOT NULL
);

CREATE TABLE operation (
  operation_id TEXT PRIMARY KEY,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('binding', 'admin')),
  actor_id TEXT NOT NULL,
  method TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL
);

CREATE TABLE event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  binding_id TEXT REFERENCES binding(id) ON DELETE RESTRICT,
  delivery_id TEXT REFERENCES delivery(id) ON DELETE RESTRICT,
  claim_id TEXT REFERENCES claim(id) ON DELETE RESTRICT,
  occurred_at INTEGER NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json))
);

CREATE TRIGGER message_is_immutable
BEFORE UPDATE ON message
BEGIN
  SELECT RAISE(ABORT, 'messages are immutable');
END;
`;

const MIGRATION_V2 = `
ALTER TABLE binding ADD COLUMN state TEXT NOT NULL DEFAULT 'bound'
  CHECK (state IN ('bound', 'unbound'));
ALTER TABLE binding ADD COLUMN state_changed_at INTEGER;
ALTER TABLE binding ADD COLUMN state_reason TEXT;

CREATE TRIGGER binding_insert_lifecycle_is_coherent
BEFORE INSERT ON binding
WHEN NOT (
  (NEW.is_current = 1 AND NEW.state = 'bound' AND NEW.inactive_at IS NULL
    AND NEW.inactive_reason IS NULL AND NEW.state_changed_at IS NULL AND NEW.state_reason IS NULL) OR
  (NEW.is_current = 1 AND NEW.state = 'unbound' AND NEW.inactive_at IS NULL
    AND NEW.inactive_reason IS NULL AND NEW.state_changed_at IS NOT NULL
    AND LENGTH(TRIM(NEW.state_reason)) > 0) OR
  (NEW.is_current = 0 AND NEW.inactive_at IS NOT NULL
    AND LENGTH(TRIM(NEW.inactive_reason)) > 0
    AND (
      (NEW.state = 'bound' AND NEW.state_changed_at IS NULL AND NEW.state_reason IS NULL) OR
      (NEW.state = 'unbound' AND NEW.state_changed_at IS NOT NULL AND LENGTH(TRIM(NEW.state_reason)) > 0)
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'binding lifecycle fields are incoherent');
END;

CREATE TRIGGER binding_identity_is_immutable
BEFORE UPDATE ON binding
WHEN NEW.id IS NOT OLD.id
  OR NEW.lane_id IS NOT OLD.lane_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.adapter IS NOT OLD.adapter
  OR NEW.conversation_id IS NOT OLD.conversation_id
  OR NEW.generation IS NOT OLD.generation
  OR NEW.active_at IS NOT OLD.active_at
BEGIN
  SELECT RAISE(ABORT, 'binding identity is immutable');
END;

CREATE TRIGGER historical_binding_is_immutable
BEFORE UPDATE ON binding
WHEN OLD.is_current = 0
BEGIN
  SELECT RAISE(ABORT, 'historical bindings are immutable');
END;

CREATE TRIGGER binding_update_must_be_lifecycle_transition
BEFORE UPDATE ON binding
WHEN OLD.is_current = 1 AND NOT (
  (OLD.state = 'bound' AND NEW.state = 'unbound' AND NEW.is_current = 1
    AND NEW.inactive_at IS NULL AND NEW.inactive_reason IS NULL
    AND NEW.state_changed_at IS NOT NULL AND LENGTH(TRIM(NEW.state_reason)) > 0) OR
  (NEW.is_current = 0 AND NEW.state = OLD.state
    AND NEW.state_changed_at IS OLD.state_changed_at
    AND NEW.state_reason IS OLD.state_reason
    AND NEW.inactive_at IS NOT NULL AND LENGTH(TRIM(NEW.inactive_reason)) > 0)
)
BEGIN
  SELECT RAISE(ABORT, 'binding update is not an allowed lifecycle transition');
END;
`;

export const LATEST_MIGRATION_VERSION = 2;

export function migrateDatabase(database: Database.Database): void {
  const currentVersion = database.pragma("user_version", { simple: true }) as number;
  if (currentVersion > LATEST_MIGRATION_VERSION) {
    throw new Error(`Database version ${currentVersion} is newer than supported version ${LATEST_MIGRATION_VERSION}`);
  }
  if (currentVersion === 0) {
    database.transaction(() => {
      database.exec(MIGRATION_V1);
      database.pragma("user_version = 1");
    })();
  }
  const versionAfterV1 = database.pragma("user_version", { simple: true }) as number;
  if (versionAfterV1 === 1) {
    database.transaction(() => {
      database.exec(MIGRATION_V2);
      database.pragma("user_version = 2");
    })();
  }
}
