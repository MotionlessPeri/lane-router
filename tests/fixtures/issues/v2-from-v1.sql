ALTER TABLE issue_thread ADD COLUMN closed_by TEXT CHECK((status='open' AND closed_by IS NULL) OR (status='closed' AND closed_by IN ('user','lane')));
UPDATE issue_thread SET closed_by='user' WHERE status='closed';
UPDATE issue_schema_version SET version=2 WHERE singleton=1;
