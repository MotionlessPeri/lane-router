import type Database from "better-sqlite3";

export function initializeKnowledgeSchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS kb_schema_version(version INTEGER NOT NULL)");
    const rows = db.prepare("SELECT version FROM kb_schema_version").all() as { version: number }[];
    if (rows.length > 1 || (rows.length === 1 && rows[0]!.version !== 1)) throw new Error("Unsupported knowledge schema version");
    db.exec(`CREATE TABLE IF NOT EXISTS kb_page(
      id TEXT PRIMARY KEY,title TEXT NOT NULL,title_key TEXT NOT NULL UNIQUE,summary TEXT NOT NULL,body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','superseded')),superseded_by TEXT REFERENCES kb_page(id),version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kb_page_version(
      page_id TEXT NOT NULL REFERENCES kb_page(id),version INTEGER NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,body TEXT NOT NULL,
      status TEXT NOT NULL,superseded_by TEXT,action TEXT NOT NULL CHECK(action IN ('create','update','supersede')),
      lane_id TEXT NOT NULL,check_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(page_id,version));
      CREATE TABLE IF NOT EXISTS kb_check(
      check_id TEXT PRIMARY KEY,lane_id TEXT NOT NULL,created_at INTEGER NOT NULL,consumed_at INTEGER,candidates_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kb_operation(
      lane_id TEXT NOT NULL,operation_key TEXT NOT NULL,operation TEXT NOT NULL,request_digest TEXT NOT NULL,result_json TEXT NOT NULL,
      PRIMARY KEY(lane_id,operation_key));
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(page_id UNINDEXED,title,summary,body,tokenize='trigram');`);
    if (rows.length === 0) db.prepare("INSERT INTO kb_schema_version VALUES(1)").run();
  })();
}
