-- Migration 035: slow_query_log table for tracking database performance (#963)

CREATE TABLE IF NOT EXISTS slow_query_log (
  id SERIAL PRIMARY KEY,
  query_hash VARCHAR(64) NOT NULL,
  query_preview VARCHAR(255) NOT NULL,
  duration_ms NUMERIC NOT NULL,
  route VARCHAR(255),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slow_query_log_occurred_at ON slow_query_log (occurred_at DESC);
