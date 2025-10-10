# Nonce Collision Analysis Report

## Executive Summary

A critical **nonce collision bug** has been identified in the Ethereum transaction queue system, causing transactions to get stuck with 0 confirmations. The issue affects operator commission payments and potentially other transaction types.

## Problem Transaction

- **TX Hash**: `0x0742319f17275aaeae4cf6044f5ff50fa3abd19cbb91d42f754d30d699996465`
- **From**: `0x9B414D02f695ACF0Cb8959D764075226F8D216a4` (escrow address)
- **Purpose**: `OP_COMMISSION`
- **Status**: `SUBMITTED` with 0 confirmations (stuck in mempool)

## Root Cause Analysis

### The Collision Pattern

1. **Simultaneous Creation**: When a deal transitions to SWAP stage, multiple queue items (`SWAP_PAYOUT` and `OP_COMMISSION`) are created with identical timestamps.

2. **Race Condition**: Both transactions are processed within ~700ms of each other, causing them to read the same nonce value before either updates it.

3. **Nonce Reuse**: Both transactions get submitted with the same nonce, causing one to succeed and the other to be rejected/replaced by the network.

### Evidence

From the database analysis:

- **Deal `9468135d`** (problematic):
  - `SWAP_PAYOUT`: Created at `08:34:33.395Z`, submitted at `08:34:39.426Z` - **COMPLETED**
  - `OP_COMMISSION`: Created at `08:34:33.395Z`, submitted at `08:34:40.133Z` - **STUCK**
  - Time difference: **707ms**

- **Deal `d2064361`** (similar pattern):
  - Both transactions created at `08:35:34.212Z`
  - Submitted within **702ms** of each other
  - Same nonce collision pattern

### Systemic Issue

This pattern appears in **ALL** Ethereum/Polygon deals:
- 10+ deals show the exact same pattern
- Always affects transactions from the same escrow address
- Always involves `SWAP_PAYOUT` and `OP_COMMISSION` pairs

## Technical Analysis

### Current Implementation Issues

1. **No Atomic Nonce Reservation**:
   ```typescript
   // Current code (Engine.ts lines 2343-2366)
   const trackedNonce = this.accountRepo.getNextNonce(...);  // READ
   // ... time passes ...
   this.accountRepo.updateLastUsedNonce(..., nonce);          // WRITE
   ```
   The gap between READ and WRITE allows race conditions.

2. **Insufficient Delay**:
   ```typescript
   // Line 2257: Only 100ms delay between transactions
   await new Promise(resolve => setTimeout(resolve, 100));
   ```

3. **No Database Transaction**:
   The nonce reservation is not wrapped in a database transaction, allowing concurrent reads.

4. **Missing Nonce Persistence**:
   The `originalNonce` column in `queue_items` is never populated, making debugging difficult.

## Impact Assessment

### Immediate Impact
- Operator commission payments stuck (0 confirmations)
- Gas fees wasted on rejected transactions
- Manual intervention required to unstick transactions

### Potential Risks
- Could affect any transaction type (refunds, payouts)
- May cause deal failures if critical transactions get stuck
- Financial losses from gas fee wastage

## Recommendations

### Immediate Fixes

1. **Atomic Nonce Reservation** (CRITICAL):
   ```typescript
   // Wrap in database transaction
   this.db.runInTransaction(() => {
     const nonce = this.accountRepo.getAndIncrementNonce(chainId, address);
     // Update queue item with nonce
     this.queueRepo.updateNonce(item.id, nonce);
   });
   ```

2. **Increase Processing Delay**:
   ```typescript
   // Increase from 100ms to 1000ms for same-sender transactions
   await new Promise(resolve => setTimeout(resolve, 1000));
   ```

3. **Add Explicit Locking**:
   ```typescript
   // Use a Map to track processing addresses
   private processingAddresses = new Map<string, Promise<void>>();

   // Wait for previous transaction to complete
   const key = `${chainId}:${address}`;
   if (this.processingAddresses.has(key)) {
     await this.processingAddresses.get(key);
   }
   ```

### Long-term Solutions

1. **Nonce Queue System**:
   - Implement a dedicated nonce queue per address
   - Pre-allocate nonces when queue items are created
   - Store nonce in `originalNonce` column

2. **Transaction Batching**:
   - Combine multiple operations into single transaction where possible
   - Use multicall contracts for EVM chains

3. **Better Monitoring**:
   - Add alerts for stuck transactions (0 confirms after X time)
   - Track nonce gaps and duplicates
   - Log all nonce allocations for debugging

## Verification Steps

To verify the fix:
1. Monitor new deals for nonce collisions
2. Check that `originalNonce` is populated
3. Verify no transactions stuck at 0 confirmations
4. Confirm sequential nonce usage per address

## Database Query for Monitoring

```sql
-- Find potential nonce collisions
SELECT
  dealId,
  fromAddr,
  COUNT(*) as tx_count,
  GROUP_CONCAT(purpose) as purposes,
  GROUP_CONCAT(status) as statuses,
  MIN(lastSubmitAt) as first_submit,
  MAX(lastSubmitAt) as last_submit,
  (julianday(MAX(lastSubmitAt)) - julianday(MIN(lastSubmitAt))) * 86400 as submit_gap_seconds
FROM queue_items
WHERE chainId IN ('ETH', 'POLYGON')
  AND lastSubmitAt IS NOT NULL
GROUP BY dealId, fromAddr
HAVING COUNT(*) > 1
  AND submit_gap_seconds < 2
ORDER BY MIN(lastSubmitAt) DESC;
```

## Conclusion

This is a **critical bug** affecting transaction reliability. The race condition in nonce management causes systematic failures in operator commission payments. Immediate action is required to implement atomic nonce reservation and proper transaction serialization.

The pattern is consistent across all deals, making this a predictable and fixable issue once proper synchronization is implemented.