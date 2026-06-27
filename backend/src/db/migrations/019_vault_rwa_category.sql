ALTER TABLE vaults ADD COLUMN IF NOT EXISTS rwa_category TEXT;
CREATE INDEX IF NOT EXISTS idx_vaults_rwa_category ON vaults (rwa_category);
