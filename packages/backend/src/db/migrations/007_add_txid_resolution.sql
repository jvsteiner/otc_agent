-- Migration: Add synthetic transaction ID resolution support
-- Enables resolution of synthetic txids (like erc20-balance-0xc2132D05) to real transaction hashes

-- Add columns to escrow_deposits table for synthetic deposit tracking (if they don't exist)
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we'll need to check in migration code
-- For now, we'll create a temporary table approach

-- Check if columns already exist by trying to select them
-- If this fails, we need to add them
-- Note: This is handled by the migration runner that catches errors

-- Try to add each column, errors will be caught if they already exist
ALTER TABLE escrow_deposits ADD COLUMN is_synthetic INTEGER DEFAULT 0;
ALTER TABLE escrow_deposits ADD COLUMN original_txid TEXT;
ALTER TABLE escrow_deposits ADD COLUMN resolution_status TEXT DEFAULT 'none';
ALTER TABLE escrow_deposits ADD COLUMN resolution_attempts INTEGER DEFAULT 0;
ALTER TABLE escrow_deposits ADD COLUMN resolved_at TEXT;
ALTER TABLE escrow_deposits ADD COLUMN resolution_metadata TEXT;

-- Audit table for tracking resolution attempts
CREATE TABLE IF NOT EXISTS txid_resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealId TEXT NOT NULL,
  chainId TEXT NOT NULL,
  address TEXT NOT NULL,
  asset TEXT NOT NULL,
  synthetic_txid TEXT NOT NULL,
  resolved_txid TEXT,
  amount TEXT NOT NULL,
  blockHeight INTEGER,
  search_from_block INTEGER,
  search_to_block INTEGER,
  matched_events_count INTEGER,
  confidence_score REAL,
  status TEXT NOT NULL, -- 'pending', 'resolved', 'failed'
  error_message TEXT,
  attempted_at TEXT NOT NULL,
  resolved_at TEXT,
  metadata_json TEXT,
  FOREIGN KEY (dealId) REFERENCES deals(dealId)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_escrow_deposits_synthetic ON escrow_deposits(is_synthetic, resolution_status);
CREATE INDEX IF NOT EXISTS idx_escrow_deposits_resolution_status ON escrow_deposits(resolution_status);
CREATE INDEX IF NOT EXISTS idx_txid_resolutions_deal ON txid_resolutions(dealId);
CREATE INDEX IF NOT EXISTS idx_txid_resolutions_status ON txid_resolutions(status);
CREATE INDEX IF NOT EXISTS idx_txid_resolutions_synthetic_txid ON txid_resolutions(synthetic_txid);
