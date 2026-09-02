-- Automatic deactivation of API keys after a period of inactivity (#934).
-- Existing keys stay active; the daily sweep flips `active` to FALSE and
-- records when it happened.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- The sweep only ever scans keys that are still active.
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys (active) WHERE active;
