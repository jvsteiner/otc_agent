-- Migration 005: Recovery System
-- Adds tables and columns for automated recovery of stuck transactions and ERC20 approvals
-- This migration is handled specially by migrate.ts

-- Create recovery audit log table
CREATE TABLE IF NOT EXISTS recovery_log (
  id TEXT PRIMARY KEY,
  dealId TEXT NOT NULL,
  recoveryType TEXT NOT NULL, -- 'ERC20_APPROVAL', 'STUCK_TX', 'FAILED_TX'
  chainId TEXT NOT NULL,
  action TEXT NOT NULL,
  success INTEGER NOT NULL, -- 0 or 1 (boolean)
  error TEXT,
  metadata TEXT, -- JSON with transaction details
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (dealId) REFERENCES deals(dealId)
);

-- Add index for recovery log queries
CREATE INDEX IF NOT EXISTS idx_recovery_log_time
  ON recovery_log(createdAt, recoveryType, success);

-- Add index for recovery log by deal
CREATE INDEX IF NOT EXISTS idx_recovery_log_deal
  ON recovery_log(dealId, createdAt);

-- Note: The leases table schema migration is handled in migrate.ts
-- to handle the schema change from (dealId, ownerId, leaseUntil) to (id, type, expiresAt)
