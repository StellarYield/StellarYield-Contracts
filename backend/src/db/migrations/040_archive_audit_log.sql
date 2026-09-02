-- Audit log for the archival job (#927).
-- Each archival run records a row per table so the verify endpoint can detect
-- row loss by comparing live + archive counts against the pre-archival total.
CREATE TABLE IF NOT EXISTS archive_audit_log (
  id              SERIAL PRIMARY KEY,
  table_name      TEXT NOT NULL,
  pre_archival_count BIGINT NOT NULL,
  archived_count  BIGINT NOT NULL DEFAULT 0,
  dry_run         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_archive_audit_log_table_created
  ON archive_audit_log (table_name, created_at DESC);
