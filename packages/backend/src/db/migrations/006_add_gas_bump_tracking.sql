-- Migration to add gas bump tracking to queue_items table

-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
-- The migration runner should handle this gracefully by catching errors

-- Create index for finding stuck transactions
CREATE INDEX IF NOT EXISTS idx_queue_stuck ON queue_items(status, lastSubmitAt)
  WHERE status = 'SUBMITTED';