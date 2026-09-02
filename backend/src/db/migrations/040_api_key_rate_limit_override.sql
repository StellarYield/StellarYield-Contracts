ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_override INTEGER;
