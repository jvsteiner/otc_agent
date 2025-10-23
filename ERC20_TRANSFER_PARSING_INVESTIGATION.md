# ERC20 Transfer Parsing Investigation Report

## Transaction Analyzed
- **TX Hash**: `0x980bf6b1f57d1479c5be1bb46bdb4bda1c7874a8a3dd26815e56695257729994`
- **Chain**: Sepolia Testnet
- **Transaction Type**: ERC20 Broker Swap (USDC)

## Root Cause Identified

### The Problem
The `getERC20Transfers()` method in EthereumPlugin is correctly implemented BUT **it is never being called** by the engine or API layer.

### What Actually Happened in the Transaction

The transaction contains **3 USDC Transfer events**:

1. **Transfer #0 (Swap)**: `0x7dbed7af...` → `0xc7dcbf13...` = 0.100000 USDC
2. **Transfer #1 (Fee)**: `0x7dbed7af...` → `0xed3f3f59...` = 0.000300 USDC
3. **Transfer #2 (Refund)**: `0x7dbed7af...` → `0x9b17b793...` = 0.099700 USDC

**Token Address**: `0x1c7d4b196cb0c7b01d743fbc6116a902379c7238` (USDC on Sepolia)

### Architecture Analysis

The broker contract (`0x4c164af901b7cdc1864c91e3ab873e5cf8dce808`) uses **escrow delegation pattern**:

```solidity
// From UnicitySwapBroker.sol line 502-503:
if (amount > 0) {
    token.safeTransferFrom(escrow, recipient, amount);
}
```

This means:
- **Transaction TO address**: Broker contract (`0x4c164af...`)
- **ERC20 Transfer FROM address**: Escrow contract (`0x7dbed7af...`)

### Why getERC20Transfers() Filtering Logic is Correct But Unused

The method at `/home/vrogojin/otc_agent/packages/chains/src/EthereumPlugin.ts` (lines 1799-1926) has this filtering:

```typescript
// Line 1838: Get broker address
const brokerAddress = (await this.brokerContract.getAddress()).toLowerCase();

// Lines 1841-1844: Filter transfers FROM broker
const brokerTransfers = transfers.filter(tx =>
  tx.from.toLowerCase() === brokerAddress &&
  BigInt(tx.value) > 0n
);
```

**ISSUE**: This filtering is incorrect for the escrow delegation pattern!

- It expects transfers FROM broker (`0x4c164af...`)
- But actual transfers are FROM escrow (`0x7dbed7af...`)
- Result: **0 transfers match** → empty array returned

### Where getERC20Transfers() Should Be Called

The code currently only calls `getInternalTransactions()`:

**File**: `/home/vrogojin/otc_agent/packages/backend/src/api/rpc-server.ts`
**Lines**: 640-643, 6013-6016

```typescript
// Current code (lines 640-643):
if (plugin && typeof plugin.getInternalTransactions === 'function') {
  console.log(`Fetching internal transactions for broker call ${item.submittedTx.txid}`);
  const internalTxs = await plugin.getInternalTransactions(item.submittedTx.txid);
  // ... handle results
}
```

**MISSING**: Parallel call to `getERC20Transfers()` for ERC20 queue items!

## The Dual Issue

There are **TWO problems** preventing ERC20 transfer parsing:

### Problem 1: Method Never Called
- `getERC20Transfers()` is implemented but never invoked by engine/API
- Only `getInternalTransactions()` is called (which only works for native currency)

### Problem 2: Incorrect Filtering Logic
- Even if called, the method filters by broker address
- But broker uses escrow delegation, so transfers come FROM escrow
- Filter should check if transfers are FROM any escrow address OR remove the broker filter entirely

## Solutions Required

### Solution 1: Call getERC20Transfers() for ERC20 Queue Items

**File**: `/home/vrogojin/otc_agent/packages/backend/src/api/rpc-server.ts`
**Location**: After line 643 (and similar location at line 6016)

Add detection of ERC20 queue items and call `getERC20Transfers()`:

```typescript
// After getInternalTransactions() call:
if (plugin && typeof plugin.getERC20Transfers === 'function') {
  // Detect if this is an ERC20 transaction
  const isERC20 = item.asset && item.asset.startsWith('EVM:') &&
                  !item.asset.includes(':NATIVE');

  if (isERC20) {
    // Extract token address from asset (e.g., "EVM:11155111:0x1c7d4b...")
    const tokenAddress = item.asset.split(':')[2];

    console.log(`[${item.chainId}] Fetching ERC20 transfers for ${item.submittedTx.txid}`);
    const erc20Transfers = await plugin.getERC20Transfers(
      item.submittedTx.txid,
      tokenAddress
    );

    if (erc20Transfers && erc20Transfers.length > 0) {
      taggedTx.erc20Transfers = erc20Transfers;
      console.log(`[${item.chainId}] Found ${erc20Transfers.length} ERC20 transfers`);
    }
  }
}
```

### Solution 2: Fix Filtering Logic in getERC20Transfers()

**File**: `/home/vrogojin/otc_agent/packages/chains/src/EthereumPlugin.ts`
**Location**: Lines 1837-1846

**Option A**: Remove broker filtering entirely (simplest)
```typescript
// Remove lines 1837-1846
// Use all transfers from the transaction (already filtered by token address)
const brokerTransfers = transfers.filter(tx => BigInt(tx.value) > 0n);
```

**Option B**: Filter by escrow addresses (more robust)
```typescript
// Get broker address to identify escrows
const brokerAddress = (await this.brokerContract.getAddress()).toLowerCase();

// Filter to transfers that are either:
// 1. FROM broker directly (legacy/future pattern), OR
// 2. FROM any address TO addresses in the transaction (escrow pattern)
const brokerTransfers = transfers.filter(tx => {
  const fromLower = tx.from.toLowerCase();
  return BigInt(tx.value) > 0n;
  // For now, accept all transfers since they're already filtered by token address
  // The transaction receipt only contains transfers related to this transaction
});
```

**Option C**: Most explicit - check transaction TO address
```typescript
// Fetch transaction details to confirm it was sent TO broker
const tx = await this.provider.getTransaction(txHash);
if (!tx) {
  console.warn(`[${this.chainId}] Transaction ${txHash} not found`);
  return [];
}

const txToAddress = tx.to?.toLowerCase();
const brokerAddress = (await this.brokerContract.getAddress()).toLowerCase();

// Only process if transaction was sent TO our broker contract
if (txToAddress !== brokerAddress) {
  console.log(`[${this.chainId}] Transaction not sent to broker (sent to ${txToAddress})`);
  return [];
}

// All transfers in this transaction receipt are from our broker operation
const brokerTransfers = transfers.filter(tx => BigInt(tx.value) > 0n);
```

## Recommended Immediate Fix

**Recommended: Option A (Remove broker filtering)**

The transaction receipt already only contains logs for THIS specific transaction. Since we're passing the `txHash` explicitly, all Transfer events in the receipt are guaranteed to be part of the broker operation. The additional filtering by broker address is unnecessary and breaks the escrow delegation pattern.

## Test Results

### Manual Test Script Output
```
=== ISSUE IDENTIFIED ===

Using WRONG broker address (0x7dbed7af...): 3 transfers
Using CORRECT broker address (0x4c164af...): 0 transfers

❌ ROOT CAUSE: The transfers are FROM an intermediate contract (0x7dbed7af...),
              NOT from the broker contract (0x4c164af...)

The broker contract (0x4c164af...) is the contract that receives the method call,
but the actual ERC20 transfers originate from an escrow contract (0x7dbed7af...).

This is why getERC20Transfers() filtering by brokerAddress fails - the "from" addresses
in Transfer events are the escrow contract, not the broker contract.
```

## Files Modified/To Modify

### Investigation Files (Created)
- `/home/vrogojin/otc_agent/test-erc20-parsing.js` - Test analysis script
- `/home/vrogojin/otc_agent/ERC20_TRANSFER_PARSING_INVESTIGATION.md` - This report

### Files Requiring Changes

1. **`/home/vrogojin/otc_agent/packages/chains/src/EthereumPlugin.ts`** (lines 1837-1846)
   - Remove or fix broker address filtering logic

2. **`/home/vrogojin/otc_agent/packages/backend/src/api/rpc-server.ts`** (lines ~643 and ~6016)
   - Add calls to `getERC20Transfers()` for ERC20 queue items
   - Add `erc20Transfers` field to `taggedTx` object

3. **Type definitions** (if needed)
   - Ensure `QueueItemTagged` includes `erc20Transfers?` field

## Next Steps

1. ✅ **Completed**: Identify root cause
2. ✅ **Completed**: Create test script demonstrating issue
3. **TODO**: Fix `getERC20Transfers()` filtering logic (remove broker filter)
4. **TODO**: Add `getERC20Transfers()` calls in rpc-server.ts
5. **TODO**: Test with Sepolia transaction
6. **TODO**: Verify ERC20 transfers appear in `otc.status` API response

## Additional Notes

- The `getERC20TransfersByTxHash()` method in EtherscanAPI is working correctly
- The classification logic (swap/fee/refund) is implemented correctly
- The issue is purely in the filtering and invocation layers
- Once fixed, ERC20 transfers will be displayed alongside internal transactions for native currency
