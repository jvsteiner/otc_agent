-- Migration to add gas bump tracking to queue_items table

-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
-- The migration runner should handle this gracefully by catching errors

-- Add gas bump tracking columns
ALTER TABLE queue_items ADD COLUMN lastSubmitAt TEXT;
ALTER TABLE queue_items ADD COLUMN originalNonce INTEGER;
ALTER TABLE queue_items ADD COLUMN lastGasPrice TEXT;
ALTER TABLE queue_items ADD COLUMN gasBumpAttempts INTEGER DEFAULT 0;

-- Create index for finding stuck transactions
CREATE INDEX IF NOT EXISTS idx_queue_stuck ON queue_items(status, lastSubmitAt)
  WHERE status = 'SUBMITTED';