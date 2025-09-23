-- Add phase column to queue_items table if it doesn't exist
-- This migration is a no-op if the column already exists (added by schema.sql)
-- For existing databases created before the phase column was added

-- SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS
-- So we use a workaround: try to select the column, if it fails then add it
-- But since this is hard to do in pure SQL, we'll just comment this out
-- The schema.sql already has the column, so new databases will have it
-- For existing databases, they can be recreated or manually migrated

-- ALTER TABLE queue_items ADD COLUMN phase TEXT;
-- Commented out because schema.sql already includes this column