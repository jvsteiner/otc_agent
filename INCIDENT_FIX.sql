-- INCIDENT FIX: Mark stuck GAS_REFUND_TO_TANK items as FAILED
-- Date: 2025-10-30
-- Issue: Cross-chain address mismatch causing infinite error loop
-- Root Cause: UNICITY chainId with EVM addresses (0x...) in toAddr field
-- These items cannot be processed because UTXO chain cannot send to EVM addresses

-- BEFORE RUNNING: Verify these are the stuck items
-- SELECT id, dealId, chainId, purpose, fromAddr, toAddr, status
-- FROM queue_items
-- WHERE chainId = 'UNICITY' AND toAddr LIKE '0x%' AND status = 'PENDING';

-- Step 1: Mark all stuck GAS_REFUND_TO_TANK items as FAILED
UPDATE queue_items
SET status = 'FAILED',
    recoveryError = 'INCIDENT_FIX: Cross-chain address mismatch - UNICITY chain cannot send to EVM address'
WHERE chainId = 'UNICITY'
  AND toAddr LIKE '0x%'
  AND status = 'PENDING'
  AND purpose = 'GAS_REFUND_TO_TANK';

-- Step 2: Also handle any other stuck PENDING items with cross-chain mismatches
-- (in case there are other similar issues)
UPDATE queue_items
SET status = 'FAILED',
    recoveryError = 'INCIDENT_FIX: Cross-chain address mismatch detected'
WHERE chainId = 'UNICITY'
  AND (toAddr LIKE '0x%' OR fromAddr LIKE '0x%')
  AND status = 'PENDING';

-- Step 3: Log the incident fix
INSERT INTO events (dealId, t, msg)
SELECT DISTINCT dealId, ?, 'INCIDENT_FIX: Marked stuck GAS_REFUND_TO_TANK as FAILED due to cross-chain mismatch'
FROM queue_items
WHERE chainId = 'UNICITY'
  AND toAddr LIKE '0x%'
  AND status = 'FAILED'
  AND recoveryError LIKE 'INCIDENT_FIX%';

-- VERIFICATION QUERIES (run after fix):
-- 1. Check no more PENDING items with cross-chain issues
-- SELECT COUNT(*) as remaining_stuck FROM queue_items
-- WHERE chainId = 'UNICITY' AND (toAddr LIKE '0x%' OR fromAddr LIKE '0x%') AND status = 'PENDING';

-- 2. Verify FAILED items
-- SELECT id, dealId, purpose, status, recoveryError FROM queue_items WHERE status = 'FAILED' AND recoveryError LIKE 'INCIDENT_FIX%';

-- 3. Monitor error events (should stop growing)
-- SELECT COUNT(*) FROM events WHERE msg LIKE '%No UTXOs available%';
