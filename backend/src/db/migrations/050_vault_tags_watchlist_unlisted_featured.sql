-- Migration 050: Admin tags GIN index, Admin watchlist, Unlisted flag, and Featured rank
-- Issues: #1283, #1284, #1285, #1286

-- #1283: GIN index on tags
CREATE INDEX IF NOT EXISTS idx_vaults_tags_gin ON vaults USING GIN (tags);

-- #1284: Admin watchlist
CREATE TABLE IF NOT EXISTS admin_watchlist (
  admin_key_id INTEGER NOT NULL,
  contract_id TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (admin_key_id, contract_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_watchlist_key ON admin_watchlist (admin_key_id);

-- #1285: Unlisted flag
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS unlisted BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_vaults_unlisted ON vaults (unlisted) WHERE unlisted = FALSE;

-- #1286: Featured vault rank
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS featured_rank INTEGER NULL;
CREATE INDEX IF NOT EXISTS idx_vaults_featured_rank ON vaults (featured_rank ASC NULLS LAST);
