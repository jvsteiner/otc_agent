-- Migration 012: Add vesting cache for UTXO ancestry tracing
-- Supports ALPHA_VESTED and ALPHA_UNVESTED asset types on Unicity

-- Persistent cache for UTXO ancestry tracing results
-- Once a UTXO is traced to its coinbase origin, the result is immutable
CREATE TABLE IF NOT EXISTS utxo_vesting_cache (
  txid TEXT PRIMARY KEY,
  is_coinbase INTEGER NOT NULL DEFAULT 0,
  coinbase_block_height INTEGER,
  parent_txid TEXT,
  vesting_status TEXT NOT NULL DEFAULT 'pending',  -- 'vested', 'unvested', 'unknown', 'pending', 'tracing_failed'
  traced_at TEXT NOT NULL,
  error_message TEXT,

  CHECK (vesting_status IN ('vested', 'unvested', 'unknown', 'pending', 'tracing_failed'))
);

-- Index for finding pending/failed traces that need retry
CREATE INDEX IF NOT EXISTS idx_vesting_status ON utxo_vesting_cache(vesting_status);

-- Index for looking up coinbase transactions by block height
CREATE INDEX IF NOT EXISTS idx_vesting_coinbase ON utxo_vesting_cache(is_coinbase, coinbase_block_height)
  WHERE is_coinbase = 1;

-- Add vesting columns to escrow_deposits for tracking deposit vesting status
-- These columns store the result of vesting classification for each deposit
ALTER TABLE escrow_deposits ADD COLUMN vesting_status TEXT;
ALTER TABLE escrow_deposits ADD COLUMN coinbase_block_height INTEGER;
