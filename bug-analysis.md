# Bug Analysis: Mixed-up Escrow Addresses on Bob's Page

## Database Truth
- **Alice (Side A) - Unicity**: `alpha1q8txwfpvhcxyteht3m0kajxnemhwa58daya0tpn`
- **Bob (Side B) - Polygon**: `0x32A2A3234D8b33Ccddf96355b51B81c1323fC130`

## Bug Location
**File**: `/home/vrogojin/otc_agent/packages/backend/src/api/rpc-server.ts`
**Lines**: 4929-4931 and 4934-4936

## Root Cause
The code incorrectly determines which escrow address to use based on the party viewing the page.

### Current Buggy Code (Lines 4926-4938):
```javascript
if (tx.type === 'in') {
  // Deposit - from external to escrow
  fromAddr = tx.from || 'External';
  toAddr = tx.escrow === 'Your escrow' ? 
    (dealData?.escrowA?.address || dealData?.escrowB?.address) :   // BUG: Always uses escrowA for "Your escrow"
    (dealData?.escrowB?.address || dealData?.escrowA?.address);    // BUG: Always uses escrowB for "Their escrow"
} else {
  // Transfer - from escrow to recipient
  fromAddr = tx.escrow === 'Your escrow' ? 
    (dealData?.escrowA?.address || dealData?.escrowB?.address) :   // BUG: Always uses escrowA for "Your escrow"
    (dealData?.escrowB?.address || dealData?.escrowA?.address);    // BUG: Always uses escrowB for "Their escrow"
  toAddr = tx.to || '';
}
```

## Problem Explanation
The code doesn't account for WHO is viewing the page:
- For **Alice's page**: "Your escrow" = escrowA (correct) ✓
- For **Bob's page**: "Your escrow" = escrowB (but code uses escrowA) ✗

This causes Bob's page to show:
- Unicity escrow (escrowA/Alice's) as the source for Polygon transactions (WRONG!)
- Polygon escrow (escrowB/Bob's) as the source for Unicity transactions (WRONG!)

## Correct Fix
The address selection must consider which party is viewing:

```javascript
if (tx.type === 'in') {
  // Deposit - from external to escrow
  fromAddr = tx.from || 'External';
  toAddr = tx.escrow === 'Your escrow' ? 
    (party === 'ALICE' ? dealData?.escrowA?.address : dealData?.escrowB?.address) :
    (party === 'ALICE' ? dealData?.escrowB?.address : dealData?.escrowA?.address);
} else {
  // Transfer - from escrow to recipient
  fromAddr = tx.escrow === 'Your escrow' ? 
    (party === 'ALICE' ? dealData?.escrowA?.address : dealData?.escrowB?.address) :
    (party === 'ALICE' ? dealData?.escrowB?.address : dealData?.escrowA?.address);
  toAddr = tx.to || '';
}
```

## Expected Behavior After Fix
### For Alice's page (party === 'ALICE'):
- "Your escrow" transactions → escrowA (Unicity: alpha1q8tx...)
- "Their escrow" transactions → escrowB (Polygon: 0x32A2A...)

### For Bob's page (party === 'BOB'):
- "Your escrow" transactions → escrowB (Polygon: 0x32A2A...)
- "Their escrow" transactions → escrowA (Unicity: alpha1q8tx...)
