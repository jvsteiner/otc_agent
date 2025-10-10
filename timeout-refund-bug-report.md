# Timeout Refund Bug Report

## Bug Summary
Deals that timed out and only had refund transactions are incorrectly shown as "Deal completed successfully!" instead of showing the proper REVERTED status.

## Example Deal
- Deal ID: `a06b8add251c5d39d54a1f2a4120dc5c` (TEST-USDT-Alpha)
- Database shows: `stage = CLOSED`
- Queue items show: Only `TIMEOUT_REFUND` transactions (no `SWAP_PAYOUT`)
- UI incorrectly displays: "Deal completed successfully! All assets have been swapped and delivered."
- Should display: "Deal cancelled/expired. Any deposited assets have been returned to payback addresses."

## Root Cause
The bug exists in two places:

### 1. Engine Bug (Primary Issue)
**File:** `/home/vrogojin/otc_agent/packages/backend/src/engine/Engine.ts`
**Lines:** 420-423

When a deal is in REVERTED stage and all refund transactions are completed, the engine incorrectly transitions the deal to CLOSED stage:

```javascript
// Current incorrect behavior (lines 420-423):
if (allConfirmed && allQueues.length > 0 && allQueues.every(q => q.status === 'COMPLETED')) {
  console.log(`[Engine] Deal ${deal.id} all refunds confirmed, marking as CLOSED`);
  this.dealRepo.updateStage(deal.id, 'CLOSED');
  this.dealRepo.addEvent(deal.id, 'All refunds confirmed - deal closed');
}
```

**The Fix:** REVERTED deals should remain in REVERTED state even after all refunds are confirmed. The CLOSED state should only be used for successful swaps.

```javascript
// Corrected behavior - DO NOT transition REVERTED to CLOSED:
if (allConfirmed && allQueues.length > 0 && allQueues.every(q => q.status === 'COMPLETED')) {
  console.log(`[Engine] Deal ${deal.id} all refunds confirmed, deal remains REVERTED`);
  this.dealRepo.addEvent(deal.id, 'All refunds confirmed - deal reverted successfully');
  // DO NOT change stage - leave as REVERTED
}
```

### 2. Frontend Safeguard (Already Fixed)
**File:** `/home/vrogojin/otc_agent/packages/backend/src/api/rpc-server.ts`
**Lines:** 4180-4197

Added a safeguard in the frontend to detect if a CLOSED deal was actually reverted by checking transaction types:

```javascript
case 'CLOSED':
  // Check if this was actually a successful swap or a refund
  const allTransactions = dealData.transactions || [];
  const hasSwapPayouts = allTransactions.some(tx => tx.purpose === 'SWAP_PAYOUT');
  const hasTimeoutRefunds = allTransactions.some(tx => tx.purpose === 'TIMEOUT_REFUND');

  // If there are no swap payouts but there are timeout refunds, this is actually a REVERTED deal
  if (!hasSwapPayouts && hasTimeoutRefunds) {
    return '<strong>Deal cancelled/expired.</strong><br>' +
      'The deal timed out before both parties could fund their escrows.<br>' +
      'Any deposited assets have been returned to payback addresses.';
  }

  // Otherwise it's a successful swap
  return '<strong>Deal completed successfully!</strong><br>' +
    'All assets have been swapped and delivered.<br>' +
    'Alice received ' + bobExpected.toFixed(4) + ' ' + bobAsset + ' on ' + bobChain + '.<br>' +
    'Bob received ' + aliceExpected.toFixed(4) + ' ' + aliceAsset + ' on ' + aliceChain + '.';
```

## Impact
- Users see incorrect success messages for failed/timed-out deals
- Deal history incorrectly shows CLOSED instead of REVERTED for failed deals
- Confusion about whether deals actually succeeded or failed

## Recommendations
1. **Immediate:** The frontend safeguard has been implemented to correctly display the status
2. **Required:** Fix the Engine bug to prevent REVERTED deals from transitioning to CLOSED
3. **Data Fix:** Consider running a database migration to correct existing deals that have `stage = CLOSED` but only have `TIMEOUT_REFUND` transactions

## Testing Scenarios
After fixing the Engine bug, test these scenarios:
1. Deal times out with no deposits → Should be REVERTED
2. Deal times out with only Alice deposits → Should be REVERTED with refunds
3. Deal times out with only Bob deposits → Should be REVERTED with refunds
4. Deal successfully swaps → Should be CLOSED
5. Deal reverts and refunds complete → Should remain REVERTED (not CLOSED)