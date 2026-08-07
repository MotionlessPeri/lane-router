import type Database from "better-sqlite3";
import { declarationDigest } from "../core/manifest.js";

export const MIGRATION_V1_SQL = `
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

export const MIGRATION_V2_SQL = `
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

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const SAFE_INTEGER_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  project: ["manifest_version", "created_at"],
  workspace: ["created_at"],
  workspace_relink: ["relinked_at"],
  lane: [],
  binding: ["generation", "active_at", "inactive_at?", "state_changed_at?"],
  message: ["created_at"],
  delivery: ["sequence", "failure_count", "deadline_at?", "next_attempt_at?", "updated_at?"],
  claim: ["generation", "lease_deadline_at", "created_at", "closed_at?"],
  ack: ["generation", "acknowledged_at"],
  operation: ["created_at"],
  event: ["occurred_at"],
};

export const MIGRATION_V3_SQL = `
CREATE TRIGGER binding_workspace_must_match_lane_project
BEFORE INSERT ON binding
WHEN (SELECT project_id FROM workspace WHERE id = NEW.workspace_id)
  IS NOT (SELECT project_id FROM lane WHERE id = NEW.lane_id)
BEGIN
  SELECT RAISE(ABORT, 'binding workspace must belong to lane project');
END;

CREATE TRIGGER workspace_project_change_must_preserve_bindings
BEFORE UPDATE OF project_id ON workspace
WHEN EXISTS (
  SELECT 1 FROM binding b JOIN lane l ON l.id=b.lane_id
  WHERE b.workspace_id=OLD.id AND l.project_id IS NOT NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'workspace project change would invalidate binding');
END;

CREATE TRIGGER lane_project_change_must_preserve_bindings
BEFORE UPDATE OF project_id ON lane
WHEN EXISTS (
  SELECT 1 FROM binding b JOIN workspace w ON w.id=b.workspace_id
  WHERE b.lane_id=OLD.id AND w.project_id IS NOT NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'lane project change would invalidate binding');
END;

CREATE TRIGGER claim_insert_must_match_delivery_context
BEFORE INSERT ON claim
WHEN NOT EXISTS (
  SELECT 1 FROM delivery d
  JOIN binding b ON b.lane_id = d.target_lane_id AND b.is_current = 1
  WHERE d.id = NEW.delivery_id
    AND d.state = 'claimed'
    AND d.deadline_kind = 'lease'
    AND d.deadline_at = NEW.lease_deadline_at
    AND b.state = 'bound'
    AND b.generation = NEW.generation
)
BEGIN
  SELECT RAISE(ABORT, 'claim must match claimed delivery and current binding');
END;

CREATE TRIGGER ack_insert_must_match_claim_and_payload
BEFORE INSERT ON ack
WHEN json_extract(NEW.outcome_payload_json, '$.kind') IS NOT NEW.outcome_kind
  OR NOT EXISTS (
    SELECT 1 FROM claim c
    JOIN delivery d ON d.id = NEW.delivery_id AND d.state = 'claimed'
    JOIN binding b ON b.lane_id = d.target_lane_id AND b.is_current = 1
    WHERE c.id = NEW.claim_id
      AND c.delivery_id = NEW.delivery_id
      AND c.generation = NEW.generation
      AND c.closed_at IS NULL
      AND b.state = 'bound'
      AND b.generation = NEW.generation
  )
BEGIN
  SELECT RAISE(ABORT, 'ack must match active claim, delivery, generation, and payload');
END;
${safeIntegerTriggerSql()}
`;

export const MIGRATION_V4_SQL = `
CREATE TABLE workspace_manifest (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE RESTRICT,
  manifest_identity TEXT NOT NULL,
  declaration_digest TEXT NOT NULL
);

CREATE TABLE project_declaration (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE RESTRICT,
  owner_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  declaration_digest TEXT NOT NULL
);

CREATE TRIGGER project_declaration_owner_must_match_project
BEFORE INSERT ON project_declaration
WHEN (SELECT project_id FROM workspace WHERE id=NEW.owner_workspace_id)
  IS NOT NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'declaration owner workspace must belong to project');
END;

CREATE TRIGGER project_declaration_update_owner_must_match_project
BEFORE UPDATE ON project_declaration
WHEN (SELECT project_id FROM workspace WHERE id=NEW.owner_workspace_id)
  IS NOT NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'declaration owner workspace must belong to project');
END;
`;

export const LATEST_MIGRATION_VERSION = 4;

export class DatabaseIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export function migrateDatabase(database: Database.Database): void {
  const currentVersion = database.pragma("user_version", { simple: true }) as number;
  if (currentVersion > LATEST_MIGRATION_VERSION) {
    throw new Error(`Database version ${currentVersion} is newer than supported version ${LATEST_MIGRATION_VERSION}`);
  }
  database.transaction(() => {
    if (currentVersion === 0) {
      database.transaction(() => {
        database.exec(MIGRATION_V1_SQL);
        database.pragma("user_version = 1");
      })();
    }
    const versionAfterV1 = database.pragma("user_version", { simple: true }) as number;
    if (versionAfterV1 === 1) {
      assertV1BindingLifecycleIntegrity(database);
      database.transaction(() => {
        database.exec(MIGRATION_V2_SQL);
        database.pragma("user_version = 2");
      })();
    }
    const versionAfterV2 = database.pragma("user_version", { simple: true }) as number;
    if (versionAfterV2 === 2) {
      assertV2Integrity(database);
      database.transaction(() => {
        database.exec(MIGRATION_V3_SQL);
        database.pragma("user_version = 3");
      })();
    }
    const versionAfterV3 = database.pragma("user_version", { simple: true }) as number;
    if (versionAfterV3 === 3) {
      assertV3Integrity(database);
      database.transaction(() => {
        database.exec(MIGRATION_V4_SQL);
        backfillManifestOwnership(database);
        database.pragma("user_version = 4");
      })();
    }
  })();
}

function assertV3Integrity(database: Database.Database): void {
  assertV2Integrity(database);
  const orphaned = database.prepare(`
    SELECT p.id FROM project p
    WHERE EXISTS (SELECT 1 FROM lane l WHERE l.project_id=p.id)
      AND NOT EXISTS (SELECT 1 FROM workspace w WHERE w.project_id=p.id)
    LIMIT 1
  `).get() as { id: string } | undefined;
  if (orphaned)
    throw new DatabaseIntegrityError(
      `Project ${orphaned.id} has declarations but no workspace owner`,
    );
}

function backfillManifestOwnership(database: Database.Database): void {
  const projects = database.prepare(
    "SELECT id,manifest_identity FROM project ORDER BY id",
  ).all() as Array<{ id: string; manifest_identity: string }>;
  for (const project of projects) {
    const lanes = database.prepare(`
      SELECT name,role_document,communication_entry
      FROM lane WHERE project_id=? ORDER BY name
    `).all(project.id) as Array<{
      name: string;
      role_document: string;
      communication_entry: number;
    }>;
    const digest = declarationDigest(
      lanes.map((lane) => ({
        name: lane.name,
        roleFile: lane.role_document,
        communicationEntry: lane.communication_entry === 1,
      })),
    );
    const workspaces = database.prepare(`
      SELECT id FROM workspace WHERE project_id=? ORDER BY created_at,id
    `).all(project.id) as Array<{ id: string }>;
    for (const workspace of workspaces)
      database.prepare(`
        INSERT INTO workspace_manifest(workspace_id,manifest_identity,declaration_digest)
        VALUES(?,?,?)
      `).run(workspace.id, project.manifest_identity, digest);
    const owner = workspaces[0];
    if (owner)
      database.prepare(`
        INSERT INTO project_declaration(project_id,owner_workspace_id,declaration_digest)
        VALUES(?,?,?)
      `).run(project.id, owner.id, digest);
  }
}

function safeIntegerTriggerSql(): string {
  return Object.entries(SAFE_INTEGER_COLUMNS)
    .filter(([, columns]) => columns.length > 0)
    .flatMap(([table, columns]) => {
      const invalid = columns.map((columnSpec) => {
        const nullable = columnSpec.endsWith("?");
        const column = nullable ? columnSpec.slice(0, -1) : columnSpec;
        const check = `typeof(NEW.${column}) != 'integer' OR NEW.${column} NOT BETWEEN -${MAX_SAFE_INTEGER} AND ${MAX_SAFE_INTEGER}`;
        return nullable ? `(NEW.${column} IS NOT NULL AND (${check}))` : `(${check})`;
      }).join(" OR ");
      return ["INSERT", "UPDATE"].map((operation) => `
CREATE TRIGGER ${table}_safe_integers_${operation.toLowerCase()}
BEFORE ${operation} ON ${table}
WHEN ${invalid}
BEGIN
  SELECT RAISE(ABORT, '${table} integer is outside JavaScript safe range');
END;`);
    }).join("\n");
}

function assertV2Integrity(database: Database.Database): void {
  const bindingInvalid = database.prepare(`
    SELECT id FROM binding
    WHERE NOT (
      (is_current = 1 AND state = 'bound' AND inactive_at IS NULL AND inactive_reason IS NULL
        AND state_changed_at IS NULL AND state_reason IS NULL) OR
      (is_current = 1 AND state = 'unbound' AND inactive_at IS NULL AND inactive_reason IS NULL
        AND state_changed_at IS NOT NULL AND LENGTH(TRIM(state_reason)) > 0) OR
      (is_current = 0 AND inactive_at IS NOT NULL AND LENGTH(TRIM(inactive_reason)) > 0
        AND ((state = 'bound' AND state_changed_at IS NULL AND state_reason IS NULL)
          OR (state = 'unbound' AND state_changed_at IS NOT NULL AND LENGTH(TRIM(state_reason)) > 0)))
    ) LIMIT 1
  `).get() as { id: string } | undefined;
  if (bindingInvalid !== undefined) {
    throw new DatabaseIntegrityError(`Binding ${bindingInvalid.id} has invalid v2 lifecycle data`);
  }

  if (tableExists(database, "lane") && tableExists(database, "workspace")) {
    const crossProject = database.prepare(`
      SELECT b.id FROM binding b JOIN lane l ON l.id=b.lane_id
      JOIN workspace w ON w.id=b.workspace_id WHERE l.project_id != w.project_id LIMIT 1
    `).get() as { id: string } | undefined;
    if (crossProject !== undefined) throw new DatabaseIntegrityError(`Binding ${crossProject.id} crosses project ownership`);
  }
  if (tableExists(database, "delivery") && tableExists(database, "claim")) {
    const badClaim = database.prepare(`
      SELECT d.id FROM delivery d WHERE d.state='claimed' AND NOT EXISTS (
        SELECT 1 FROM claim c JOIN binding b
          ON b.lane_id=d.target_lane_id AND b.generation=c.generation
        WHERE c.delivery_id=d.id AND c.closed_at IS NULL
          AND c.lease_deadline_at=d.deadline_at
      ) UNION ALL
      SELECT c.delivery_id FROM claim c JOIN delivery d ON d.id=c.delivery_id
      WHERE c.closed_at IS NULL AND (
        d.state!='claimed' OR c.lease_deadline_at!=d.deadline_at OR NOT EXISTS (
          SELECT 1 FROM binding b
          WHERE b.lane_id=d.target_lane_id AND b.generation=c.generation
        )
      )
      LIMIT 1
    `).get() as { id: string } | undefined;
    if (badClaim !== undefined) throw new DatabaseIntegrityError(`Claim integrity failed for delivery ${badClaim.id}`);
  }
  if (tableExists(database, "ack")) {
    const badAck = database.prepare(`
      SELECT a.delivery_id AS id FROM ack a WHERE
        json_extract(a.outcome_payload_json, '$.kind') IS NOT a.outcome_kind OR NOT EXISTS (
          SELECT 1 FROM claim c WHERE c.id=a.claim_id
            AND c.delivery_id=a.delivery_id AND c.generation=a.generation
        ) LIMIT 1
    `).get() as { id: string } | undefined;
    if (badAck !== undefined) throw new DatabaseIntegrityError(`Ack integrity failed for delivery ${badAck.id}`);
  }
  assertSafeIntegerIntegrity(database);
}

function assertSafeIntegerIntegrity(database: Database.Database): void {
  for (const [table, columns] of Object.entries(SAFE_INTEGER_COLUMNS)) {
    if (columns.length === 0 || !tableExists(database, table)) continue;
    const invalid = columns.map((columnSpec) => {
      const nullable = columnSpec.endsWith("?");
      const column = nullable ? columnSpec.slice(0, -1) : columnSpec;
      const check = `typeof(${column}) != 'integer' OR ${column} NOT BETWEEN -${MAX_SAFE_INTEGER} AND ${MAX_SAFE_INTEGER}`;
      return nullable ? `(${column} IS NOT NULL AND (${check}))` : `(${check})`;
    }).join(" OR ");
    const row = database.prepare(`SELECT rowid FROM ${table} WHERE ${invalid} LIMIT 1`).get();
    if (row !== undefined) throw new DatabaseIntegrityError(`${table} contains an unsafe integer`);
  }
}

function tableExists(database: Database.Database, table: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}

function assertV1BindingLifecycleIntegrity(database: Database.Database): void {
  const invalid = database.prepare(`
    SELECT id FROM binding
    WHERE generation <= 0
      OR is_current NOT IN (0, 1)
      OR (is_current = 1 AND (inactive_at IS NOT NULL OR inactive_reason IS NOT NULL))
      OR (is_current = 0 AND (
        inactive_at IS NULL OR inactive_reason IS NULL OR LENGTH(TRIM(inactive_reason)) = 0
      ))
    LIMIT 1
  `).get() as { id: string } | undefined;
  if (invalid !== undefined) {
    throw new DatabaseIntegrityError(
      `Binding ${invalid.id} has invalid lifecycle data; repair it before migration`,
    );
  }
}
