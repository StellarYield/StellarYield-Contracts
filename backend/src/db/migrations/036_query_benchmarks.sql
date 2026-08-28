-- Issue #964: query performance regression detection.
--
-- Records the duration of the top hot queries on each deployment so the
-- compare endpoint can flag regressions > 20% between base and head deploys.
CREATE TABLE IF NOT EXISTS query_benchmarks (
  id           SERIAL PRIMARY KEY,
  deploy_id    TEXT NOT NULL,
  query_name   TEXT NOT NULL,
  duration_ms  DOUBLE PRECISION NOT NULL,
  run_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deploy_id, query_name)
);

CREATE INDEX IF NOT EXISTS idx_query_benchmarks_deploy
  ON query_benchmarks (deploy_id, query_name);
