-- Composite index on (state, total_assets DESC) for vault sort queries (#655)
CREATE INDEX CONCURRENTLY IF NOT EXISTS vaults_state_assets_idx ON vaults (state, total_assets DESC);
