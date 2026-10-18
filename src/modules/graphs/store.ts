import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { validateDocument } from "./document.js";
import { initializeGraphSchema } from "./schema.js";
import type { GraphLock, GraphOperation, GraphResource } from "./types.js";

export function openGraphStore(path: string): GraphStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("foreign_keys=ON"); initializeGraphSchema(db);
    db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL");
    return new GraphStore(db);
  } catch (error) { db.close(); throw error; }
}

export class GraphStore {
  constructor(private readonly db: Database.Database) {}
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  resource(id: string): GraphResource | null {
    const row = this.db.prepare("SELECT id,document_json AS json,created_at AS createdAt,updated_at AS updatedAt FROM graph_resource WHERE id=?").get(id) as { id: string; json: string; createdAt: number; updatedAt: number } | undefined;
    return row ? { id: row.id, document: validateDocument(JSON.parse(row.json)), createdAt: row.createdAt, updatedAt: row.updatedAt } : null;
  }
  list(query: { query?: string; afterId?: string; limit?: number }): { id: string; title: string; updatedAt: number }[] {
    return this.db.prepare(`SELECT id,json_extract(document_json,'$.title') AS title,updated_at AS updatedAt FROM graph_resource
      WHERE (? IS NULL OR id>?) AND (? IS NULL OR instr(lower(json_extract(document_json,'$.title') || ' ' || coalesce(json_extract(document_json,'$.description'),'')),lower(?))>0)
      ORDER BY id LIMIT ?`).all(query.afterId ?? null, query.afterId ?? null, query.query ?? null, query.query ?? null, (query.limit ?? 50) + 1) as { id: string; title: string; updatedAt: number }[];
  }
  save(resource: GraphResource): void {
    this.db.prepare(`INSERT INTO graph_resource(id,document_json,created_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json,updated_at=excluded.updated_at`).run(resource.id, JSON.stringify(resource.document), resource.createdAt, resource.updatedAt);
  }
  lock(id: string): GraphLock | null {
    return this.db.prepare("SELECT graph_id AS graphId,lock_id AS lockId,lane_id AS laneId,acquired_at AS acquiredAt FROM graph_lock WHERE graph_id=?").get(id) as GraphLock | undefined ?? null;
  }
  insertLock(lock: GraphLock): void {
    this.db.prepare("INSERT INTO graph_lock(graph_id,lock_id,lane_id,acquired_at) VALUES(@graphId,@lockId,@laneId,@acquiredAt)").run(lock);
  }
  deleteLock(id: string): void { this.db.prepare("DELETE FROM graph_lock WHERE graph_id=?").run(id); }
  operation(laneId: string, key: string): GraphOperation | null {
    const row = this.db.prepare("SELECT operation,request_digest AS digest,result_json AS json FROM graph_operation WHERE lane_id=? AND operation_key=?").get(laneId, key) as { operation: string; digest: string; json: string } | undefined;
    return row ? { laneId, key, operation: row.operation, digest: row.digest, result: JSON.parse(row.json) as Record<string, unknown> } : null;
  }
  recordOperation(op: GraphOperation): void {
    this.db.prepare("INSERT INTO graph_operation(lane_id,operation_key,operation,request_digest,result_json) VALUES(?,?,?,?,?)").run(op.laneId, op.key, op.operation, op.digest, JSON.stringify(op.result));
  }
  close(): void { if (this.db.open) this.db.close(); }
}
