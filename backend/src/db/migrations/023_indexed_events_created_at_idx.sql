-- Add index on indexed_events.created_at for efficient time-range queries (#677)
CREATE INDEX CONCURRENTLY IF NOT EXISTS ie_created_at_idx ON indexed_events (created_at DESC);
