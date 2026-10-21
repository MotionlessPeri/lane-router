import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { initializeKnowledgeSchema } from "./schema.js";
import type { KnowledgeCheck, KnowledgeOperation, KnowledgePage, PageStatus, PageVersion } from "./types.js";

export function openKnowledgeStore(path: string): KnowledgeStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("foreign_keys=ON"); initializeKnowledgeSchema(db);
    db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL");
    return new KnowledgeStore(db);
  } catch (error) { db.close(); throw error; }
}

const PAGE = "id,title,summary,body,status,superseded_by AS supersededBy,version,created_at AS createdAt,updated_at AS updatedAt";
const VERSION = "page_id AS pageId,version,title,summary,body,status,superseded_by AS supersededBy,action,lane_id AS laneId,check_id AS checkId,created_at AS createdAt";
export interface DirectoryEntry { pageId: string; title: string; summary: string; status: PageStatus; updatedAt: number }

export class KnowledgeStore {
  constructor(private readonly db: Database.Database) {}
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  page(id: string): KnowledgePage | null { return this.db.prepare(`SELECT ${PAGE} FROM kb_page WHERE id=?`).get(id) as KnowledgePage | undefined ?? null; }
  pageByTitleKey(key: string): KnowledgePage | null { return this.db.prepare(`SELECT ${PAGE} FROM kb_page WHERE title_key=?`).get(key) as KnowledgePage | undefined ?? null; }
  pages(ids: readonly string[]): KnowledgePage[] {
    return ids.length === 0 ? [] : this.db.prepare(`SELECT ${PAGE} FROM kb_page WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as KnowledgePage[];
  }
  savePage(page: KnowledgePage, titleKey: string): void {
    this.db.prepare(`INSERT INTO kb_page(id,title,title_key,summary,body,status,superseded_by,version,created_at,updated_at)
      VALUES(@id,@title,@titleKey,@summary,@body,@status,@supersededBy,@version,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,title_key=excluded.title_key,summary=excluded.summary,body=excluded.body,
      status=excluded.status,superseded_by=excluded.superseded_by,version=excluded.version,updated_at=excluded.updated_at`).run({ ...page, titleKey });
  }
  insertVersion(row: PageVersion): void {
    this.db.prepare(`INSERT INTO kb_page_version(page_id,version,title,summary,body,status,superseded_by,action,lane_id,check_id,created_at)
      VALUES(@pageId,@version,@title,@summary,@body,@status,@supersededBy,@action,@laneId,@checkId,@createdAt)`).run(row);
  }
  versions(pageId: string): PageVersion[] { return this.db.prepare(`SELECT ${VERSION} FROM kb_page_version WHERE page_id=? ORDER BY version`).all(pageId) as PageVersion[]; }
  version(pageId: string, version: number): PageVersion | null {
    return this.db.prepare(`SELECT ${VERSION} FROM kb_page_version WHERE page_id=? AND version=?`).get(pageId, version) as PageVersion | undefined ?? null;
  }
  /** The search index follows the page row; callers keep both in one transaction. */
  indexPage(page: KnowledgePage): void {
    this.db.prepare("DELETE FROM kb_fts WHERE page_id=?").run(page.id);
    this.db.prepare("INSERT INTO kb_fts(page_id,title,summary,body) VALUES(?,?,?,?)").run(page.id, page.title, page.summary, page.body);
  }
  /** Trigram phrase match: a substring search over title, summary and body for terms of three characters or more. */
  match(term: string): string[] {
    return (this.db.prepare("SELECT page_id AS id FROM kb_fts WHERE kb_fts MATCH ?").all(`"${term.replaceAll('"', '""')}"`) as { id: string }[]).map(row => row.id);
  }
  /** The trigram index cannot match shorter terms, so they fall back to a plain substring scan. */
  like(term: string): string[] {
    const pattern = `%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`;
    return (this.db.prepare("SELECT id FROM kb_page WHERE title LIKE @p ESCAPE '\\' OR summary LIKE @p ESCAPE '\\' OR body LIKE @p ESCAPE '\\'").all({ p: pattern }) as { id: string }[]).map(row => row.id);
  }
  directory(query: { afterId?: string; limit?: number }): DirectoryEntry[] {
    const after = query.afterId === undefined ? "" : "WHERE (title_key,id)>((SELECT title_key FROM kb_page WHERE id=@afterId),@afterId)";
    return this.db.prepare(`SELECT id AS pageId,title,summary,status,updated_at AS updatedAt FROM kb_page ${after} ORDER BY title_key,id ${query.limit === undefined ? "" : "LIMIT @limit"}`)
      .all({ ...(query.afterId === undefined ? {} : { afterId: query.afterId }), ...(query.limit === undefined ? {} : { limit: query.limit }) }) as DirectoryEntry[];
  }
  countActive(): number { return (this.db.prepare("SELECT count(*) AS n FROM kb_page WHERE status='active'").get() as { n: number }).n; }
  insertCheck(check: KnowledgeCheck): void {
    this.db.prepare("INSERT INTO kb_check(check_id,lane_id,created_at,consumed_at,candidates_json) VALUES(?,?,?,?,?)")
      .run(check.checkId, check.laneId, check.createdAt, check.consumedAt, JSON.stringify(check.candidates));
  }
  check(checkId: string): KnowledgeCheck | null {
    const row = this.db.prepare("SELECT check_id AS checkId,lane_id AS laneId,created_at AS createdAt,consumed_at AS consumedAt,candidates_json AS json FROM kb_check WHERE check_id=?")
      .get(checkId) as Omit<KnowledgeCheck, "candidates"> & { json: string } | undefined;
    if (!row) return null;
    const { json, ...check } = row; return { ...check, candidates: JSON.parse(json) as KnowledgeCheck["candidates"] };
  }
  consumeCheck(checkId: string, at: number): void { this.db.prepare("UPDATE kb_check SET consumed_at=? WHERE check_id=?").run(at, checkId); }
  operation(laneId: string, key: string): KnowledgeOperation | null {
    const row = this.db.prepare("SELECT operation,request_digest AS digest,result_json AS json FROM kb_operation WHERE lane_id=? AND operation_key=?").get(laneId, key) as { operation: string; digest: string; json: string } | undefined;
    return row ? { laneId, key, operation: row.operation, digest: row.digest, result: JSON.parse(row.json) as Record<string, unknown> } : null;
  }
  recordOperation(op: KnowledgeOperation): void {
    this.db.prepare("INSERT INTO kb_operation(lane_id,operation_key,operation,request_digest,result_json) VALUES(?,?,?,?,?)").run(op.laneId, op.key, op.operation, op.digest, JSON.stringify(op.result));
  }
  close(): void { if (this.db.open) this.db.close(); }
}
