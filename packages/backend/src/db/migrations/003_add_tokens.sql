-- Add tokens table for persistent token storage
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  dealId TEXT NOT NULL,
  party TEXT NOT NULL CHECK (party IN ('ALICE', 'BOB')),
  createdAt TEXT NOT NULL,
  usedAt TEXT,
  FOREIGN KEY (dealId) REFERENCES deals(dealId)
);

CREATE INDEX IF NOT EXISTS idx_tokens_dealId ON tokens(dealId);