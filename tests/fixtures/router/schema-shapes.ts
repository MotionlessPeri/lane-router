/**
 * Router databases as earlier builds left them, pinned here instead of imported from schema.ts:
 * schema.ts describes the current version, so a fixture built from it would hand a migration a
 * database no real build ever wrote.
 *
 * Versions 7 and 8 were numbered on two machines at once. One line of work used them for two new
 * binding backends (7 `dsh`, 8 `zcode`); the other used 7 for the message sender label, which is
 * version 9 after the two were merged. So "version 7" names two different databases here.
 */

const LANE_SQL = `
CREATE TABLE lane (
  id TEXT PRIMARY KEY, address TEXT NOT NULL, project TEXT NOT NULL,
  role_description TEXT NOT NULL CHECK (length(trim(role_description)) > 0),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model TEXT, archived_at INTEGER
);
CREATE UNIQUE INDEX lane_live_address_idx ON lane(address) WHERE archived_at IS NULL;
CREATE INDEX lane_project_address_idx ON lane(project,address);
`;

/** The binding table with its backend CHECK as a given version left it. */
function bindingSql(backends: string): string {
  return `
CREATE TABLE binding (
  id TEXT PRIMARY KEY, lane_id TEXT NOT NULL REFERENCES lane(id) ON DELETE RESTRICT,
  backend TEXT NOT NULL CHECK (backend IN ${backends}), conversation_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0), startup_json TEXT NOT NULL,
  active_at INTEGER NOT NULL, inactive_at INTEGER, cwd TEXT
);
CREATE UNIQUE INDEX binding_active_lane_idx ON binding(lane_id) WHERE inactive_at IS NULL;
CREATE UNIQUE INDEX binding_active_conversation_idx ON binding(backend,conversation_id) WHERE inactive_at IS NULL;
CREATE UNIQUE INDEX binding_lane_generation_idx ON binding(lane_id,generation);
`;
}

/** Both message tables as version 6 left them: every message names the lane that sent it. */
export const MESSAGE_TABLES_V6_SQL = `
CREATE TABLE message (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE,
  sender_lane_id TEXT NOT NULL REFERENCES lane(id) ON DELETE RESTRICT,
  target_lane_id TEXT NOT NULL REFERENCES lane(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('normal','correction')), reply_to TEXT,
  relative_path TEXT NOT NULL UNIQUE, content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','resolved')),
  created_at INTEGER NOT NULL, resolved_at INTEGER,
  ack_lane_id TEXT REFERENCES lane(id) ON DELETE RESTRICT, ack_generation INTEGER,
  notification_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (notification_state IN ('pending','sent','deferred','no_channel','send_failed')),
  CHECK (
    (state='pending' AND resolved_at IS NULL AND ack_lane_id IS NULL AND ack_generation IS NULL) OR
    (state='resolved' AND resolved_at IS NOT NULL AND ack_lane_id IS NOT NULL AND ack_generation > 0)
  )
);
CREATE INDEX message_target_state_idx ON message(target_lane_id,state,created_at,id);
CREATE TABLE message_archive (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL, sender_lane_id TEXT NOT NULL, target_lane_id TEXT NOT NULL,
  kind TEXT NOT NULL, reply_to TEXT, relative_path TEXT NOT NULL, content_sha256 TEXT NOT NULL,
  state TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER, ack_lane_id TEXT,
  ack_generation INTEGER, notification_state TEXT NOT NULL, archived_at INTEGER NOT NULL
);
`;

/** Both message tables with the sender pair, as the tell build left them at its version 7. */
export const MESSAGE_TABLES_WITH_SENDER_LABEL_SQL = `
CREATE TABLE message (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE,
  sender_lane_id TEXT REFERENCES lane(id) ON DELETE RESTRICT,
  sender_label TEXT,
  target_lane_id TEXT NOT NULL REFERENCES lane(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('normal','correction')), reply_to TEXT,
  relative_path TEXT NOT NULL UNIQUE, content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','resolved')),
  created_at INTEGER NOT NULL, resolved_at INTEGER,
  ack_lane_id TEXT REFERENCES lane(id) ON DELETE RESTRICT, ack_generation INTEGER,
  notification_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (notification_state IN ('pending','sent','deferred','no_channel','send_failed')),
  CHECK ((sender_lane_id IS NULL) <> (sender_label IS NULL)),
  CHECK (
    (state='pending' AND resolved_at IS NULL AND ack_lane_id IS NULL AND ack_generation IS NULL) OR
    (state='resolved' AND resolved_at IS NOT NULL AND ack_lane_id IS NOT NULL AND ack_generation > 0)
  )
);
CREATE INDEX message_target_state_idx ON message(target_lane_id,state,created_at,id);
CREATE TABLE message_archive (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL, sender_lane_id TEXT, sender_label TEXT,
  target_lane_id TEXT NOT NULL, kind TEXT NOT NULL, reply_to TEXT, relative_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER,
  ack_lane_id TEXT, ack_generation INTEGER, notification_state TEXT NOT NULL, archived_at INTEGER NOT NULL,
  CHECK ((sender_lane_id IS NULL) <> (sender_label IS NULL))
);
`;

export const BINDING_BACKENDS = {
  v6: "('claude','codex')",
  dsh: "('claude','codex','dsh')",
  zcode: "('claude','codex','dsh','zcode')",
} as const;

/** Every shape a database from version 6 on can be in, with the version its build stamped on it. */
export const STARTING_SHAPES = {
  "v6": { version: 6, bindingBackends: BINDING_BACKENDS.v6, senderLabel: false },
  "v7 (DSH)": { version: 7, bindingBackends: BINDING_BACKENDS.dsh, senderLabel: false },
  "v8 (ZCode)": { version: 8, bindingBackends: BINDING_BACKENDS.zcode, senderLabel: false },
  "v7 (tell)": { version: 7, bindingBackends: BINDING_BACKENDS.v6, senderLabel: true },
  "v9": { version: 9, bindingBackends: BINDING_BACKENDS.zcode, senderLabel: true },
} as const;

export type StartingShape = keyof typeof STARTING_SHAPES;

export function schemaSql(shape: { readonly bindingBackends: string; readonly senderLabel: boolean }): string {
  return `${LANE_SQL}${bindingSql(shape.bindingBackends)}${shape.senderLabel ? MESSAGE_TABLES_WITH_SENDER_LABEL_SQL : MESSAGE_TABLES_V6_SQL}`;
}

/** The version 6 shape both lines of work started from. */
export const SCHEMA_V6_SQL = schemaSql(STARTING_SHAPES.v6);
