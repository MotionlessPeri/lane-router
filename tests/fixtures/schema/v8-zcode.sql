
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

CREATE INDEX message_target_state_idx ON message(target_lane_id,state,created_at,id);

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

PRAGMA user_version=8;
