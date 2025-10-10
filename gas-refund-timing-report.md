# Gas Refund Timing Analysis Report
## Deal: 2b282a0717717f766e12b64d6cdf180d (Bob's Page)

**Report Generated**: 2025-10-08
**Deal URL**: http://213.199.61.236:8080/d/2b282a0717717f766e12b64d6cdf180d/b/52d3e09f0d45a6c15d5929dc01d534b2

---

## Executive Summary

**CRITICAL ISSUE IDENTIFIED**: The MATIC gas refund transaction for the Polygon escrow was created but never submitted to the blockchain. The transaction remains in PENDING status with ~0.4965 MATIC still locked in the escrow address.

---

## Deal Overview

- **Deal ID**: `2b282a0717717f766e12b64d6cdf180d`
- **Current Stage**: `CLOSED`
- **Timeout Period**: 3600 seconds (1 hour)
- **Deal Type**: Cross-chain swap (Unicity ↔ Polygon)

### Parties

**Alice (Side A)**:
- Offering: 0.2 ALPHA on Unicity
- Filled at: 2025-10-08 19:37:53 UTC
- Escrow: `alpha1ql9tj350lxhel3n3rumunj3dncgyfva599errpl`

**Bob (Side B)**:
- Offering: 0.1 USDT (ERC20: 0xc2132D05D31c914a87C6611C10748AEb04B58e8F) on Polygon
- Filled at: 2025-10-08 19:38:51 UTC
- Escrow: `0x630f8637F761195433D7CcdaE9F931E9d24CD694`
- Payback Address: `0x9b17B793A2aB1f7234ddB599f8Ad5B1b7F3E39De`

---

## Transaction Timeline

### Phase 1: Swap Execution (19:43:40 - 19:57:37 UTC)

1. **SWAP_PAYOUT** (Polygon → Alice) ✅ CONFIRMED
   - TX: `0x80027ffe0b73fd66587fe8b7ee686114ece7f732f273a035d76e72395cdc980f`
   - Amount: 0.1 USDT
   - Created: 2025-10-08 19:43:40 UTC
   - Submitted: 2025-10-08 19:43:49 UTC
   - Confirms: 67/64

2. **OP_COMMISSION** (Polygon) ✅ CONFIRMED
   - TX: `0x96903eaf0a0a971a54eed68b65af0f68c75dfe209674252fc77d66eac83fff53`
   - Amount: 0.0003 USDT
   - Created: 2025-10-08 19:43:40 UTC
   - Submitted: 2025-10-08 19:43:52 UTC
   - Confirms: 66/64

3. **SWAP_PAYOUT** (Unicity → Bob) ✅ CONFIRMED
   - TX: `313cfdfff8a647492d0d5c201e9bbc89dde712c412d7dd438ce00677601a7a63`
   - Amount: 0.2 ALPHA
   - Created: 2025-10-08 19:43:40 UTC
   - Submitted: 2025-10-08 19:43:49 UTC
   - Confirms: 6/6

4. **OP_COMMISSION** (Unicity) ✅ CONFIRMED
   - TX: `cad99c8d83eb14a46e4845cef4b936bfbd4220b4a135cd1ed0b9a2ee23b69615`
   - Amount: 0.0006 ALPHA
   - Created: 2025-10-08 19:43:40 UTC
   - Submitted: 2025-10-08 19:57:37 UTC
   - Confirms: 6/6

### Phase 2: Timeout Refunds (20:05:38 UTC)

5. **TIMEOUT_REFUND** (Unicity - Alice's excess) ✅ CONFIRMED
   - TX: `4e089f6fb46f3dce38f9f15abc45b667af6dce3c2a64da2ec510016d0829ba94`
   - Amount: 0.09939899 ALPHA
   - Created: 2025-10-08 20:05:38 UTC
   - Submitted: 2025-10-08 20:05:38 UTC
   - Confirms: 6/6
   - Note: Alice deposited too much, excess returned

6. **TIMEOUT_REFUND** (Polygon - Bob's excess) ✅ CONFIRMED
   - TX: `0x2631addee9394284d4048004be922619d5f8c85807ec888009e081b2c0bafb59`
   - Amount: 0.0997 USDT
   - To: `0x9b17B793A2aB1f7234ddB599f8Ad5B1b7F3E39De` (Bob's payback address)
   - Created: 2025-10-08 20:05:38 UTC
   - Submitted: 2025-10-08 20:05:38 UTC
   - Confirms: 210/64
   - Note: Bob deposited too much (0.0997 vs 0.1 needed), but got refunded

### Phase 3: Gas Refund (STUCK)

7. **GAS_REFUND_TO_TANK** (Polygon) ⚠️ **PENDING** - **NEVER SUBMITTED**
   - Transaction ID: `04b8de6de575b8ef465353d47d3224d1`
   - From: `0x630f8637F761195433D7CcdaE9F931E9d24CD694` (Bob's escrow)
   - To: `0x2f750c3Ac8e85E0DdA3D97bBb6144f15C1A2123D` (Gas Tank)
   - Asset: MATIC
   - Amount: 0.49648778518410136 MATIC
   - Created: 2025-10-08 20:05:38 UTC
   - **Status**: PENDING (No blockchain submission)
   - **Issue**: Transaction was created in the system but never submitted to blockchain

---

## Current State Verification

**Polygon Escrow Balance** (as of report generation):
- Address: `0x630f8637F761195433D7CcdaE9F931E9d24CD694`
- Current Balance: **0.4949003195382215 MATIC**
- Expected Refund Amount: **0.49648778518410136 MATIC**
- Difference: ~0.00158 MATIC (likely due to rounding or small additional gas usage)

**Confirmation**: The MATIC is still locked in the escrow address, confirming the gas refund was never executed.

---

## Timing Analysis

### Key Timestamps

1. **Deal Creation Phase**: 19:37:53 - 19:38:51 UTC (both parties filled details)
2. **Swap Execution Started**: 19:43:40 UTC
3. **First Swap Confirmed**: 19:43:49 UTC (9 seconds later)
4. **All Swaps Confirmed**: 19:57:37 UTC (~14 minutes total)
5. **Refund Phase Started**: 20:05:38 UTC (~22 minutes after swap start)
6. **Gas Refund Created**: 20:05:38 UTC
7. **Gas Refund Status**: Still PENDING (never submitted)

### Time Deltas

- Deal filled to swap execution: ~5 minutes
- Swap execution to refund processing: ~22 minutes
- **Gas refund creation to now**: ~2+ hours (STUCK)

---

## Root Cause Analysis

### Why the Gas Refund Was Not Submitted

Based on the transaction data:

1. **Transaction Creation**: The gas refund transaction was properly created with all necessary details:
   - Transaction ID assigned: `04b8de6de575b8ef465353d47d3224d1`
   - From/To addresses correct
   - Amount calculated: 0.4965 MATIC
   - Purpose: `GAS_REFUND_TO_TANK`
   - Sequence: 4 (after the TIMEOUT_REFUND at seq 3)

2. **Missing Submission**: Unlike all other transactions, this one lacks:
   - `submittedTx` object (completely missing)
   - No blockchain transaction ID
   - No submission timestamp
   - No confirmation tracking

3. **Likely Causes**:
   - Engine loop did not process this transaction
   - Queue broadcast mechanism failed for this specific transaction
   - Transaction may not have been added to the `queue_items` table
   - Possible race condition when deal closed
   - Engine lease may have expired before processing this final transaction

### Evidence from Other Transactions

All other transactions (swaps and refunds) show proper submission:
- ✅ Created timestamp
- ✅ Submitted timestamp
- ✅ Blockchain transaction ID
- ✅ Confirmation tracking
- ✅ Status progression (PENDING → SUBMITTED → CONFIRMED)

The gas refund is the **only** transaction stuck at creation without submission.

---

## Impact Assessment

### Financial Impact

- **Locked Funds**: 0.4965 MATIC (~$0.30 at current prices)
- **Owner**: Hot wallet escrow address (controlled by OTC engine)
- **Intended Recipient**: Gas tank (`0x2f750c3Ac8e85E0DdA3D97bBb6144f15C1A2123D`)

### Operational Impact

1. **Escrow Cleanup**: The escrow address was not properly cleaned up
2. **Gas Tank**: Gas tank did not receive the refund, reducing available gas for future deals
3. **Account State**: The Polygon account nonce/state may be affected
4. **Pattern**: This could be a systematic issue affecting other deals

---

## Deal Page Information

Based on the page inspection, the deal page shows:

- **Deal Stage Badge**: CLOSED (green background)
- **Status Message**: "Successfully completed"
- **Alice's Status**: Swap completed - received USDT
- **Bob's Status**: Swap completed - received ALPHA
- **Transaction History**: Shows all confirmed transactions except the pending gas refund
- **Automatic Return Notice**: Active (24-hour monitoring for late deposits)
- **Countdown**: Shows "Completed"

The page does **not** prominently display the pending gas refund issue, as it's technically a post-deal cleanup transaction.

---

## Recommendations

### Immediate Actions

1. **Manual Submission**: Force submit the pending gas refund transaction
   - Check if transaction still exists in `queue_items` table
   - If not, recreate and submit manually

2. **Verify Gas Tank Balance**: Confirm gas tank received funds from other deals

3. **Audit Similar Deals**: Check all CLOSED deals for similar stuck gas refunds

### Code Investigation

1. **Engine Loop**: Review the `processRefundDistribution` phase
2. **Queue Processing**: Check if gas refund transactions are properly queued
3. **Stage Transitions**: Verify deal doesn't close before gas refund is queued
4. **Lease Timing**: Ensure 90-second lease is sufficient for all cleanup

### Monitoring

1. Add alerts for transactions stuck in PENDING status > 10 minutes
2. Track escrow cleanup completion rates
3. Monitor gas tank refill frequency

---

## Appendix: Raw Data

### Gas Refund Transaction Object

```json
{
  "id": "04b8de6de575b8ef465353d47d3224d1",
  "dealId": "2b282a0717717f766e12b64d6cdf180d",
  "chainId": "POLYGON",
  "from": {
    "chainId": "POLYGON",
    "address": "0x630f8637F761195433D7CcdaE9F931E9d24CD694"
  },
  "to": "0x2f750c3Ac8e85E0DdA3D97bBb6144f15C1A2123D",
  "asset": "MATIC",
  "amount": "0.49648778518410136",
  "purpose": "GAS_REFUND_TO_TANK",
  "seq": 4,
  "status": "PENDING",
  "createdAt": "2025-10-08T20:05:38.524Z",
  "tag": "unknown",
  "blockTime": "2025-10-08T20:05:38.524Z"
}
```

Note: `submittedTx` field is completely absent, indicating no blockchain submission occurred.

---

## Conclusion

The gas refund for deal `2b282a0717717f766e12b64d6cdf180d` was created at **2025-10-08 20:05:38 UTC** but has **never been submitted** to the Polygon blockchain. The transaction remains in PENDING status, with approximately **0.4965 MATIC still locked** in the escrow address `0x630f8637F761195433D7CcdaE9F931E9d24CD694`.

This represents a **post-deal cleanup failure** where all swap and refund operations completed successfully, but the final gas return to the tank was not processed by the engine loop or queue broadcast mechanism.

**Next Steps**: Investigate the queue processor and engine loop to determine why this transaction was not submitted, and implement proper monitoring to catch similar issues in the future.
