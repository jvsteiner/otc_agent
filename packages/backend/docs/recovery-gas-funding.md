# Recovery Manager Gas Funding Implementation

## Overview

The RecoveryManager now has self-contained gas funding capabilities to automatically fund escrow addresses with gas before executing ERC20 approvals. This ensures that recovery operations can succeed even when escrow accounts lack native currency for gas fees.

## Implementation Approach

We chose **Option 1: Self-contained gas funding** for the following reasons:

1. **Simplicity**: RecoveryManager operates independently without TankManager dependency
2. **Minimal changes**: Uses existing ethers infrastructure from the EVM plugin
3. **Consistency**: Follows the same pattern as TankManager but avoids circular dependencies
4. **Reliability**: Direct control over gas funding for recovery operations

## Architecture

### Key Components

1. **Tank Wallet Management**
   - Private key sourced from `TANK_WALLET_PRIVATE_KEY` environment variable
   - Separate ethers wallet instance per chain (ETH, POLYGON, SEPOLIA, BSC, BASE)
   - Automatic initialization on RecoveryManager startup

2. **Gas Funding Logic**
   - Checks escrow balance before approval
   - Estimates required gas for ERC20 approval (~65k gas units)
   - Funds with predefined amounts per chain
   - Tracks funding actions in recovery log

3. **Fallback Strategy**
   - Prefers TankManager if available
   - Falls back to self-contained funding
   - Operates without funding if neither available

### Configuration

Default gas funding amounts per chain:
- **ETH**: 0.01 ETH
- **POLYGON**: 0.5 MATIC
- **SEPOLIA**: 0.01 ETH
- **BSC**: 0.005 BNB
- **BASE**: 0.005 ETH

### Environment Variables

```bash
# Tank wallet for gas funding (same as TankManager)
TANK_WALLET_PRIVATE_KEY=0x...

# Chain RPC endpoints
ETH_RPC=https://eth-mainnet.g.alchemy.com/v2/...
POLYGON_RPC=https://polygon-rpc.com
SEPOLIA_RPC=https://sepolia.infura.io/v3/...
BSC_RPC=https://bsc-dataseed.binance.org
BASE_RPC=https://mainnet.base.org
```

## Integration Flow

### ERC20 Approval Recovery

1. **Detection**: RecoveryManager detects missing ERC20 approval
2. **Gas Check**: Calls `ensureGasFunding()` before approval
3. **Funding**:
   - If TankManager available: Uses `tankManager.fundEscrowForGas()`
   - Otherwise: Uses self-contained funding via tank wallet
4. **Wait**: Brief pause (3s) for funding confirmation
5. **Approval**: Executes `approveBrokerForERC20()`
6. **Logging**: Records all actions in recovery log

### Error Handling

- **Insufficient Tank Balance**: Logs alert, continues without funding
- **RPC Failures**: Logs error, falls back to next option
- **No Funding Available**: Warns and attempts approval anyway

## Code Changes

### Modified Files

1. **RecoveryManager.ts**
   - Added `tankWalletPrivateKey` to config
   - Added `tankWallets` Map for chain-specific wallets
   - Added `gasFundAmounts` Map with default amounts
   - Implemented `initializeTankWallets()` method
   - Implemented `ensureGasFunding()` method
   - Integrated gas funding into `approveBrokerForERC20()`

2. **index.ts**
   - Updated RecoveryManager instantiation comment

### New Files

1. **test/recovery-gas-funding.test.ts**
   - Comprehensive test suite for gas funding
   - Tests initialization, configuration, and logging

## Benefits

1. **Automatic Recovery**: ERC20 approvals no longer fail due to lack of gas
2. **Flexible Configuration**: Works with or without TankManager
3. **Chain Support**: Supports all major EVM chains
4. **Monitoring**: Tracks all funding actions and alerts on low balance
5. **Resilience**: Multiple fallback options ensure recovery continues

## Monitoring

The system logs several key events:

- **Initialization**: Shows which funding method is available
- **Tank Balances**: Displays initial balances on startup
- **Funding Actions**: Records each gas funding transaction
- **Low Balance Alerts**: Warns when tank balance is insufficient
- **Errors**: Logs all failures with context

## Future Enhancements

1. **Dynamic Gas Estimation**: Calculate exact gas needed per transaction type
2. **Configurable Amounts**: Allow per-chain funding amounts via environment
3. **Metrics Collection**: Track gas usage and costs over time
4. **Auto-refill**: Automatically request tank refill when low
5. **Multi-wallet Support**: Use different tank wallets per chain

## Testing

Run the test suite:

```bash
cd packages/backend
npx vitest test/recovery-gas-funding.test.ts --run
```

Tests cover:
- Initialization with/without tank wallet
- Gas funding configuration
- Recovery action logging
- Low balance alerts