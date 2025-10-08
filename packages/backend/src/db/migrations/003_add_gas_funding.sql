-- Migration: Add gas funding support
-- Track gas funding transactions from tank to escrows
CREATE TABLE IF NOT EXISTS gas_funding (
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

-- Track tank wallet balances per chain
CREATE TABLE IF NOT EXISTS tank_balances (
  chainId TEXT PRIMARY KEY,
  balance TEXT NOT NULL,
  lastUpdated TEXT NOT NULL,
  lowThreshold TEXT NOT NULL
);

-- Alerts for operational monitoring
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  payload_json TEXT,
  createdAt TEXT NOT NULL,
  resolvedAt TEXT
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_gas_funding_deal ON gas_funding(dealId);
CREATE INDEX IF NOT EXISTS idx_gas_funding_status ON gas_funding(status);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolvedAt);