-- Issue #965: store k6 benchmark run results so the comparison endpoint can
-- diff any two named runs.
CREATE TABLE IF NOT EXISTS benchmark_results (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  p50_ms      NUMERIC NOT NULL,
  p95_ms      NUMERIC NOT NULL,
  p99_ms      NUMERIC NOT NULL,
  error_rate  NUMERIC NOT NULL  -- fraction 0–1
);

-- Fast lookup by name + timestamp for the two-run comparison query.
CREATE INDEX IF NOT EXISTS idx_benchmark_results_name_recorded_at
  ON benchmark_results (name, recorded_at);
