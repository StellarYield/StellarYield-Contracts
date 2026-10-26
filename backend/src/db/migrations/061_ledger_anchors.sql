-- Create ledger_anchors table populated every 1000 ledgers for sequence-to-timestamp interpolation
CREATE TABLE IF NOT EXISTS ledger_anchors (
  ledger      BIGINT PRIMARY KEY,
  closed_at   TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_anchors_ledger ON ledger_anchors (ledger);
