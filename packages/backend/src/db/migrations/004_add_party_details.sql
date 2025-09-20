-- Add party_details table for persistent storage of wallet addresses
CREATE TABLE IF NOT EXISTS party_details (
  dealId TEXT NOT NULL,
  party TEXT NOT NULL CHECK (party IN ('ALICE', 'BOB')),
  paybackAddress TEXT NOT NULL,
  recipientAddress TEXT NOT NULL,
  email TEXT,
  filledAt TEXT NOT NULL,
  locked INTEGER DEFAULT 1,
  escrowAddress TEXT,
  escrowKeyRef TEXT,
  PRIMARY KEY (dealId, party),
  FOREIGN KEY (dealId) REFERENCES deals(dealId)
);

CREATE INDEX IF NOT EXISTS idx_party_details_dealId ON party_details(dealId);
CREATE INDEX IF NOT EXISTS idx_party_details_paybackAddress ON party_details(paybackAddress);
CREATE INDEX IF NOT EXISTS idx_party_details_recipientAddress ON party_details(recipientAddress);