-- Add closed_at column to epochs for webhook idempotency (#819).
-- closed_at is set exactly once when totalClaimed >= yieldAmount.
ALTER TABLE epochs ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
