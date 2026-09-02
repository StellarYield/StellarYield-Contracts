-- Add exclude_from_archive flag to vaults (#926).
-- Vaults with this flag set to TRUE are skipped by the archival job.
ALTER TABLE vaults
  ADD COLUMN IF NOT EXISTS exclude_from_archive BOOLEAN NOT NULL DEFAULT FALSE;
