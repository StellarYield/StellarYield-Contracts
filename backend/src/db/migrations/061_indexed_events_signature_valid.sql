-- Issue #1172: track cryptographic validation of indexed contract events.
ALTER TABLE indexed_events
  ADD COLUMN IF NOT EXISTS signature_valid BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_indexed_events_signature_valid
  ON indexed_events (signature_valid, created_at DESC);

ALTER TABLE indexed_events_archive
  ADD COLUMN IF NOT EXISTS signature_valid BOOLEAN NOT NULL DEFAULT TRUE;
