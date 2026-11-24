ALTER TABLE indexer_contract_state
  ADD COLUMN IF NOT EXISTS last_indexed_ledger INT NULL,
  ADD COLUMN IF NOT EXISTS last_indexed_at TIMESTAMPTZ NULL;
