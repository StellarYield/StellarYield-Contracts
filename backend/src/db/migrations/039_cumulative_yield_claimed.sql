-- Track each holder's cumulative lifetime yield claim within the latest snapshot row.
ALTER TABLE share_balance_snapshots
  ADD COLUMN IF NOT EXISTS cumulative_yield_claimed NUMERIC NOT NULL DEFAULT 0;

