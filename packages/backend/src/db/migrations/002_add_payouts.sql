-- Create payouts table for tracking multi-transaction payouts (especially for UTXO chains like Unicity)
CREATE TABLE IF NOT EXISTS payouts (
  payoutId TEXT PRIMARY KEY,      -- Unique identifier for the payout
  dealId TEXT NOT NULL,
  chainId TEXT NOT NULL,
  fromAddr TEXT NOT NULL,
  toAddr TEXT NOT NULL,
  asset TEXT NOT NULL,
  totalAmount TEXT NOT NULL,      -- Total amount to be sent
  purpose TEXT NOT NULL,          -- SWAP, COMMISSION, REFUND
  phase TEXT,                     -- For UTXO chains
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, SUBMITTED, CONFIRMED
  minConfirmations INTEGER,       -- Minimum confirmations across all transactions
  createdAt TEXT NOT NULL,
  completedAt TEXT,
  metadata TEXT                   -- JSON for additional data
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_payouts_deal ON payouts(dealId);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);
CREATE INDEX IF NOT EXISTS idx_queue_payout ON queue_items(payoutId);