# ERC-20 Timeout Refund Gas Fix

## Problem Fixed
ERC-20 timeout refunds were failing because escrow addresses had depleted their gas reserves during swap and commission transactions, leaving no ETH/MATIC for the timeout refund transaction.

## Solution Implemented
Added automatic gas funding for ERC-20 token refunds before queueing timeout refund transactions.

## Changes Made

### 1. New Helper Method: `ensureGasForRefund()`
**Location:** `/home/vrogojin/otc_agent/packages/backend/src/engine/Engine.ts` (lines 1145-1229)

This helper method:
- Checks if the asset is an ERC-20 token on an EVM chain (ETH/Polygon)
- If yes, uses TankManager to fund the escrow with gas before refund
- Estimates gas requirements for ERC-20 transfer
- Funds escrow address with required gas from tank wallet
- Logs the funding transaction and adds it to deal events
- Returns success/failure status but doesn't block refunds on failure

### 2. Updated `revertDeal()` Method
**Location:** `/home/vrogojin/otc_agent/packages/backend/src/engine/Engine.ts` (lines 1276-1334)

- **Before queueing refunds:** Calls `ensureGasForRefund()` for all ERC-20 deposits
- Processes gas funding for both Alice and Bob's deposits in parallel
- Waits for all gas funding operations to complete before queueing refunds
- Proceeds with refunds even if gas funding fails (user can manually fund)

### 3. Updated Post-Close Monitor
**Location:** `/home/vrogojin/otc_agent/packages/backend/src/engine/Engine.ts`

Updated two locations in the post-close monitor that handles late/surplus deposits:
- **Alice's escrow monitor** (lines 1707-1717): Calls `ensureGasForRefund()` before queueing surplus refunds
- **Bob's escrow monitor** (lines 1820-1830): Calls `ensureGasForRefund()` before queueing surplus refunds

## How It Works

1. **Detection:** When a timeout occurs or surplus funds are detected, the system checks if the asset is ERC-20 on an EVM chain
2. **Gas Estimation:** Calculates required gas for ERC-20 transfer (with 20% safety margin)
3. **Funding:** Tank wallet sends native currency (ETH/MATIC) to escrow for gas
4. **Refund:** Once gas is available, the timeout refund transaction is queued
5. **Fallback:** If tank funding fails, refund is still attempted (user can manually fund)

## Configuration Required
The fix requires a configured Tank Manager with:
- `TANK_WALLET_PRIVATE_KEY` environment variable
- Sufficient ETH/MATIC balance in tank wallet
- Per-chain gas fund amounts configured

## Testing Scenarios
The fix handles these scenarios:
1. ✅ ERC-20 timeout refunds when escrow has no gas
2. ✅ Multiple ERC-20 deposits requiring refunds
3. ✅ Mixed native and ERC-20 deposits
4. ✅ Post-close surplus ERC-20 refunds
5. ✅ Tank wallet not configured (logs warning, continues)
6. ✅ Tank wallet empty (logs error, still attempts refund)

## Key Benefits
- Automatic gas funding prevents stuck ERC-20 tokens
- Non-blocking: Refunds proceed even if gas funding fails
- Comprehensive: Covers timeout refunds and post-close surplus
- Transparent: All gas funding is logged in deal events
- Efficient: Parallel gas funding for multiple deposits