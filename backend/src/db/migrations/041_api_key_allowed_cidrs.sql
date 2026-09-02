-- Per-key IP CIDR restriction (#928).
-- NULL (the default) means the key may be used from any IP.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS allowed_cidrs TEXT[];
