-- Issues #970, #971: track a free-text vault description and a display logo URI
-- on-chain. `description` may already exist from #975 (024_vault_description_search);
-- both additions are idempotent.
ALTER TABLE vaults
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS logo_uri        TEXT;
