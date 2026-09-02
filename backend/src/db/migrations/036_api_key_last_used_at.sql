-- Track when each API key was last used for a successful authentication (#933).
-- NULL means the key has never been used.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- Supports the "stale key" lookups used by the admin key list and the
-- inactivity sweep (#934), which order/filter on the last-used timestamp.
CREATE INDEX IF NOT EXISTS idx_api_keys_last_used_at ON api_keys (last_used_at);
