ALTER TABLE issue_attachment ADD COLUMN position INTEGER CHECK(position IS NULL OR (typeof(position)='integer' AND position>=0));
UPDATE issue_schema_version SET version=4 WHERE singleton=1;
