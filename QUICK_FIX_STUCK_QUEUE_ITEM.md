# Quick Fix: Stuck Queue Item "No UTXOs Available for Spending"

## Problem
Queue item `51d7d2e9d9c3403ae6abf867f4eb2f2a` is stuck in infinite retry loop:
- Error: `No UTXOs available for spending`
- Retrying every 30 seconds indefinitely
- Logs showing 9,533+ failures

## Root Cause
Phase 1 completion logic incorrectly treated empty phases as "complete", allowing Phase 2 (commission payment) to execute from an unfunded UTXO address.

## Immediate Recovery (Manual)

### Step 1: Stop Infinite Retries
Mark the queue item as FAILED to stop retries:
```bash
sqlite3 ./data/otc-production.db << 'EOF'
UPDATE queue_items
SET status = 'FAILED'
WHERE id = '51d7d2e9d9c3403ae6abf867f4eb2f2a';
EOF
```

### Step 2: Revert Deal to REVERTED
Return funds to users by reverting the deal:
```bash
sqlite3 ./data/otc-production.db << 'EOF'
UPDATE deals
SET stage = 'REVERTED'
WHERE id = '199746102e0f9256db7d61b32ccbfcef';
EOF
```

### Step 3: Record Event
Add event for audit trail:
```bash
sqlite3 ./data/otc-production.db << 'EOF'
INSERT INTO events (dealId, t, msg, category)
VALUES ('199746102e0f9256db7d61b32ccbfcef', datetime('now'), 'Manually failed stuck OP_COMMISSION item (no UTXOs) and reverted deal', 'STATE_CHANGE');
EOF
```

### Step 4: Verify
Check the changes:
```bash
sqlite3 ./data/otc-production.db << 'EOF'
SELECT id, status FROM queue_items WHERE id = '51d7d2e9d9c3403ae6abf867f4eb2f2a';
SELECT id, stage FROM deals WHERE id = '199746102e0f9256db7d61b32ccbfcef';
EOF
```

Expected output:
```
51d7d2e9d9c3403ae6abf867f4eb2f2a|FAILED
199746102e0f9256db7d61b32ccbfcef|REVERTED
```

### Step 5: Restart Backend
```bash
npm run prod
```

## Permanent Fix

The bug is fixed in the code. Deploy the updated version:

1. **Code changes applied to**:
   - `/home/vrogojin/otc_agent/packages/backend/src/db/repositories/QueueRepository.ts`
   - `/home/vrogojin/otc_agent/packages/backend/src/engine/Engine.ts`

2. **Build and deploy**:
   ```bash
   npm run build
   npm run prod
   ```

## Verification

After fix deployment, you should see:
- ✓ Phase completion logic correctly distinguishes empty vs complete phases
- ✓ No more "No UTXOs available" errors for commission payments
- ✓ Phase 1 empty conditions handled gracefully
- ✓ Phase 2 skipped if Phase 1 is empty (expected for broker mode)

## Testing the Fix

### Test Case: Unfunded Escrow
1. Create deal with Alice on UNICITY, Bob on POLYGON
2. Only Bob funds his escrow (Alice doesn't)
3. Expected: Deal times out or reverts, commission never sent
4. Verify: No "No UTXOs available" errors

### Test Case: Full Funding
1. Create deal with both parties funding
2. Expected: Both Phase 1 and Phase 2 execute successfully
3. Verify: Commission payment succeeds

## Related Documentation

- Full analysis: `/home/vrogojin/otc_agent/UTXO_BUG_ROOT_CAUSE_FIX.md`
- Architecture: `/home/vrogojin/otc_agent/CLAUDE.md` (Phase processing section)

## Questions?

Check the logs:
```bash
tail -f ./logs/otc-prod-*.log | grep -E "Phase|UTXO|OP_COMMISSION"
```

Key metrics to watch:
- Phase items vs Phase completed status ratio
- Empty phase transitions
- Commission payment success rate
