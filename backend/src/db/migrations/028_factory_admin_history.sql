-- Track factory admin transfers for audit purposes (#839)

CREATE TABLE IF NOT EXISTS factory_admin_history (
  id           SERIAL PRIMARY KEY,
  old_admin    TEXT NOT NULL,
  new_admin    TEXT NOT NULL,
  ledger       INT NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_factory_admin_history_recorded_at ON factory_admin_history (recorded_at DESC);
