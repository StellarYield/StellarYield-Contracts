-- Issue #1214: Store the transaction and event position of each indexed event so
-- ordering within a ledger is deterministic and reproducible.
--
-- tx_index / event_index come from the Soroban RPC event `id` (a TOID plus a
-- trailing event index). They are nullable: rows written before this migration
-- have no position and fall back to insertion order via the id tiebreak.

ALTER TABLE indexed_events
  ADD COLUMN IF NOT EXISTS tx_index    INT,
  ADD COLUMN IF NOT EXISTS event_index INT;

CREATE INDEX IF NOT EXISTS idx_indexed_events_ordering
  ON indexed_events (ledger, tx_index, event_index, id);
