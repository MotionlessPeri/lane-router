
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
CREATE INDEX issue_attachment_unattached_idx ON issue_attachment(created_at) WHERE entry_id IS NULL;
UPDATE issue_schema_version SET version=3 WHERE singleton=1;
