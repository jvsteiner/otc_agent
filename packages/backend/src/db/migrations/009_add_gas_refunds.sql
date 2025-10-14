-- Migration 009: Add gas refunds tracking
-- Tracks automatic gas refunds from ERC20 escrows back to tank after approval completion

CREATE TABLE IF NOT EXISTS gas_refunds (
  id TEXT PRIMARY KEY,
  dealId TEXT NOT NULL,
  chainId TEXT NOT NULL,
  escrowAddress TEXT NOT NULL,
  approvalTxHash TEXT,            -- The ERC20 approval transaction that triggered this refund
  refundAmount TEXT NOT NULL,     -- Amount of native currency being refunded
  refundTxHash TEXT,              -- The actual refund transaction hash (once submitted)
  status TEXT NOT NULL,           -- 'QUEUED', 'SUBMITTED', 'CONFIRMED', 'FAILED'
  createdAt INTEGER NOT NULL,     -- When refund was queued
  submittedAt INTEGER,            -- When refund was submitted to blockchain
  completedAt INTEGER,            -- When refund was confirmed on-chain
  error TEXT,                     -- Error message if status is FAILED
  queueItemId TEXT,               -- Reference to queue_items table
  metadata TEXT,                  -- JSON with additional details (gas prices, thresholds, etc.)
  FOREIGN KEY (dealId) REFERENCES deals(dealId),
  FOREIGN KEY (queueItemId) REFERENCES queue_items(id)
);

-- Ensure only one gas refund per escrow/approval combination
-- This prevents double refunds even if approval is re-checked
CREATE UNIQUE INDEX IF NOT EXISTS idx_gas_refunds_escrow_approval
  ON gas_refunds(escrowAddress, approvalTxHash);

-- Index for querying refunds by deal
CREATE INDEX IF NOT EXISTS idx_gas_refunds_deal
  ON gas_refunds(dealId, createdAt DESC);

-- Index for querying pending/active refunds
CREATE INDEX IF NOT EXISTS idx_gas_refunds_status
  ON gas_refunds(status, createdAt);

-- Index for querying refunds by chain (for tank balance tracking)
CREATE INDEX IF NOT EXISTS idx_gas_refunds_chain
  ON gas_refunds(chainId, status);
