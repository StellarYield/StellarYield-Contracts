ALTER TABLE vaults
  ADD COLUMN IF NOT EXISTS decimals INT NULL,
  ADD COLUMN IF NOT EXISTS decimals_mismatch BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  ALTER TABLE vaults
    ADD CONSTRAINT vaults_decimals_range
    CHECK (decimals IS NULL OR (decimals >= 0 AND decimals <= 18));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
