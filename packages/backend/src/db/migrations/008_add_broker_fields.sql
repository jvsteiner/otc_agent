-- Add broker-specific fields to queue_items table
-- These fields are used for BROKER_SWAP, BROKER_REVERT, and BROKER_REFUND queue items

-- SQLite doesn't have IF NOT EXISTS for ALTER TABLE, so we handle this in code
-- The migration runner should check if columns exist before adding them
