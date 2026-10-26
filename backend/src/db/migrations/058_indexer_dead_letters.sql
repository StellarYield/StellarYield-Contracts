CREATE TABLE IF NOT EXISTS indexer_dead_letters (
  id            BIGSERIAL PRIMARY KEY,
  contract_id   TEXT NOT NULL,
  ledger        INT NOT NULL,
  raw_event     JSONB NOT NULL,
  error_message TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_indexer_dead_letters_created_at
  ON indexer_dead_letters (created_at DESC, id DESC);
