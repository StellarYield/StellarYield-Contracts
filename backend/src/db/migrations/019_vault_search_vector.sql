-- Add full-text search support for vaults
-- Generated tsvector column for indexing name and description
ALTER TABLE vaults
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', COALESCE(name, '') || ' ' || COALESCE(symbol, ''))
  ) STORED;

-- Create GIN index for fast full-text search
CREATE INDEX idx_vaults_search_vector ON vaults USING GIN (search_vector);
