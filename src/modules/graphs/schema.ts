import type Database from "better-sqlite3";

export function initializeGraphSchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS graph_schema_version(version INTEGER NOT NULL)");
    const rows = db.prepare("SELECT version FROM graph_schema_version").all() as { version: number }[];
    if (rows.length > 1 || (rows.length === 1 && rows[0]!.version !== 1)) throw new Error("Unsupported graphs schema version");
    db.exec(`CREATE TABLE IF NOT EXISTS graph_resource(
      id TEXT PRIMARY KEY,document_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS graph_lock(
      graph_id TEXT PRIMARY KEY REFERENCES graph_resource(id),lock_id TEXT NOT NULL UNIQUE,lane_id TEXT NOT NULL,acquired_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS graph_operation(
      lane_id TEXT NOT NULL,operation_key TEXT NOT NULL,operation TEXT NOT NULL,request_digest TEXT NOT NULL,result_json TEXT NOT NULL,
      PRIMARY KEY(lane_id,operation_key));`);
    if (rows.length === 0) db.prepare("INSERT INTO graph_schema_version VALUES(1)").run();
  })();
}
