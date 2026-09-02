CREATE TABLE IF NOT EXISTS benchmark_results (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  p50         DOUBLE PRECISION NOT NULL,
  p95         DOUBLE PRECISION NOT NULL,
  p99         DOUBLE PRECISION NOT NULL,
  error_rate  DOUBLE PRECISION NOT NULL,
  timestamp   TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_benchmark_results_name ON benchmark_results (name);
CREATE INDEX IF NOT EXISTS idx_benchmark_results_name_ts ON benchmark_results (name, timestamp DESC);
