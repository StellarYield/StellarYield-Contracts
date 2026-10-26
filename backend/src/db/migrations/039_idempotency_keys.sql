-- Idempotency-Key support for admin POST endpoints (#1186).
-- One row per (key, route) so a retried request with the same body replays the
-- stored response instead of executing the handler twice.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT        NOT NULL,
  route           TEXT        NOT NULL,
  request_hash    TEXT        NOT NULL,
  response_status INTEGER     NOT NULL,
  response_body   JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key, route)
);

-- Supports the 24-hour purge sweep.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON idempotency_keys (created_at);
