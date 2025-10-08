-- Migration: Fix gas_funding foreign key constraint
-- This migration corrects the foreign key that was incorrectly referencing deals(id) instead of deals(dealId)

-- First, we need to check if the gas_funding table exists and if it has the wrong constraint
-- SQLite doesn't support ALTER TABLE DROP CONSTRAINT, so we need to recreate the table

-- Step 1: Create a temporary table to preserve existing data (if any)
CREATE TABLE IF NOT EXISTS gas_funding_temp AS
SELECT * FROM gas_funding WHERE 1=1;

-- Step 2: Drop the existing gas_funding table (with incorrect FK)
DROP TABLE IF EXISTS gas_funding;

-- Step 3: Recreate the gas_funding table with correct foreign key constraint
CREATE TABLE gas_funding (
  id TEXT PRIMARY KEY,
  dealId TEXT NOT NULL,
  chainId TEXT NOT NULL,
  escrowAddress TEXT NOT NULL,
  fundingAmount TEXT NOT NULL,
  txHash TEXT,
  createdAt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  confirmedAt TEXT,
  FOREIGN KEY (dealId) REFERENCES deals(dealId)
);

-- Step 4: Restore data from temporary table (if any exists)
-- Using INSERT OR IGNORE to make it idempotent
INSERT OR IGNORE INTO gas_funding
SELECT id, dealId, chainId, escrowAddress, fundingAmount, txHash, createdAt, status, confirmedAt
FROM gas_funding_temp WHERE 1=1;

-- Step 5: Drop the temporary table
DROP TABLE IF EXISTS gas_funding_temp;

-- Step 6: Recreate indexes that were dropped with the table
CREATE INDEX IF NOT EXISTS idx_gas_funding_deal ON gas_funding(dealId);
CREATE INDEX IF NOT EXISTS idx_gas_funding_status ON gas_funding(status);

-- Migration complete: gas_funding table now has correct foreign key to deals(dealId)