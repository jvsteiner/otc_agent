# Deployment Guide: Array Storage Escrow System

**Version:** 1.0.0
**Contract:** UnicitySwapEscrowImplementationArray
**Date:** 2025-10-10

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Pre-Deployment Checklist](#2-pre-deployment-checklist)
3. [Testnet Deployment](#3-testnet-deployment)
4. [Mainnet Deployment](#4-mainnet-deployment)
5. [Post-Deployment Verification](#5-post-deployment-verification)
6. [Contract Verification on Etherscan](#6-contract-verification-on-etherscan)
7. [Rollback Procedure](#7-rollback-procedure)
8. [Gas Cost Estimates](#8-gas-cost-estimates)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Prerequisites

### Software Requirements

- **Foundry** (latest version)
  ```bash
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
  ```

- **Node.js** 18+ (for verification scripts)
  ```bash
  node --version  # Should be 18.x or higher
  ```

### Account Setup

1. **Deployer Account**
   - Create new wallet for deployment
   - Fund with sufficient native currency:
     - Testnet: 0.1 ETH equivalent
     - Mainnet: 0.5 ETH equivalent (safety margin)

2. **Operator Account**
   - Backend service wallet (will execute swaps)
   - Must be accessible by your backend

3. **Fee Recipient Account**
   - Wallet to receive protocol fees
   - Should be secure multisig (recommended)

4. **Gas Tank Account**
   - Wallet to receive gas refunds
   - Can be same as fee recipient or separate treasury

### Environment Variables

Create `.env` file in `contracts/` directory:

```bash
# Deployment
DEPLOYER_PRIVATE_KEY=0x...  # Your deployer private key (KEEP SECRET!)

# Network RPCs
MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY

# Etherscan API Keys (for verification)
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_API_KEY
POLYGONSCAN_API_KEY=YOUR_POLYGONSCAN_API_KEY

# Production Addresses (see Pre-Deployment Checklist)
ESCROW_OPERATOR=0x...
FEE_RECIPIENT=0x...
GAS_TANK=0x...
```

**Security:** Never commit `.env` file to version control!

---

## 2. Pre-Deployment Checklist

### Critical: Update Hardcoded Constants

**⚠️ MANDATORY BEFORE MAINNET DEPLOYMENT**

Edit `/home/vrogojin/otc_agent/contracts/src/optimized/UnicitySwapEscrowImplementationArray.sol`:

```solidity
// Lines 34-40: Update these addresses!

/// @notice Backend operator address - MUST BE CONFIGURED BEFORE DEPLOYMENT
address internal constant ESCROW_OPERATOR = 0xYOUR_OPERATOR_ADDRESS_HERE;

/// @notice Fee recipient address - MUST BE CONFIGURED BEFORE DEPLOYMENT
address payable internal constant FEE_RECIPIENT = payable(0xYOUR_FEE_RECIPIENT_HERE);

/// @notice Gas tank address - MUST BE CONFIGURED BEFORE DEPLOYMENT
address payable internal constant GAS_TANK = payable(0xYOUR_GAS_TANK_HERE);
```

### Verification Checklist

- [ ] `ESCROW_OPERATOR` is your backend service address
- [ ] `FEE_RECIPIENT` is your fee collection address (multisig recommended)
- [ ] `GAS_TANK` is your gas refund address
- [ ] All addresses are NOT test addresses (0x1, 0x2, 0x3, etc.)
- [ ] All addresses are controlled by your organization
- [ ] Private keys for operator are securely stored
- [ ] `.env` file created with all required variables
- [ ] Deployer account funded with sufficient gas
- [ ] Security audit completed (see ARRAY_STORAGE_SECURITY_AUDIT.md)
- [ ] All tests passing (28/28)

---

## 3. Testnet Deployment

### Purpose

Test the full deployment process and contract functionality before mainnet.

### Recommended Testnets

- **Ethereum:** Sepolia (reliable, well-supported)
- **Polygon:** Mumbai or Amoy
- **Arbitrum:** Sepolia
- **Base:** Sepolia

### Step-by-Step Testnet Deployment

#### Step 1: Compile Contracts

```bash
cd /home/vrogojin/otc_agent/contracts
forge build
```

Expected output: `Compiler run successful!`

#### Step 2: Run Tests

```bash
forge test --match-path test/optimized/ArrayStorageSecurityTest.t.sol -vv
```

Expected: All 28 tests pass.

#### Step 3: Deploy to Testnet

```bash
forge script script/DeployArrayStorageTestnet.s.sol:DeployArrayStorageTestnet \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --verify \
  -vvvv
```

**What happens:**
1. Deploys Implementation contract
2. Deploys Beacon contract (points to Implementation)
3. Deploys Factory contract (uses Beacon)
4. Deploys Mock ERC20 token for testing
5. Creates test escrow instance
6. Runs 6 verification tests
7. Saves deployment info to `deployments/testnet-{chainId}.json`

#### Step 4: Verify Deployment

Check deployment file:
```bash
cat deployments/testnet-*.json
```

Should contain all deployed addresses.

#### Step 5: Test Full Swap Flow

```bash
# Use Cast to interact with deployed contracts
export FACTORY_ADDRESS=$(cat deployments/testnet-*.json | jq -r '.factory')
export TEST_TOKEN=$(cat deployments/testnet-*.json | jq -r '.mockERC20')

# Create escrow
cast send $FACTORY_ADDRESS "createEscrow(address,address,address,uint256,uint256)" \
  $PAYBACK $RECIPIENT $TEST_TOKEN 1000000000000000000000 3000000000000000000 \
  --rpc-url $SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY

# Fund escrow and execute swap (see testing scripts)
```

---

## 4. Mainnet Deployment

### Pre-Flight Checks

**⚠️ STOP AND VERIFY:**

- [ ] Testnet deployment successful
- [ ] All functionality tested on testnet
- [ ] Hardcoded addresses updated (CRITICAL!)
- [ ] External audit completed (recommended)
- [ ] Team review completed
- [ ] Deployer account funded (0.5 ETH safety margin)
- [ ] Backup plan documented
- [ ] Monitoring system ready

### Mainnet Deployment Steps

#### Step 1: Final Code Review

```bash
# Verify hardcoded addresses one more time
grep -n "ESCROW_OPERATOR\|FEE_RECIPIENT\|GAS_TANK" \
  src/optimized/UnicitySwapEscrowImplementationArray.sol
```

**Ensure addresses are NOT:**
- 0x0000000000000000000000000000000000000001
- 0x0000000000000000000000000000000000000002
- 0x0000000000000000000000000000000000000003

#### Step 2: Compile for Mainnet

```bash
forge clean
forge build --force
```

#### Step 3: Deploy to Mainnet

```bash
forge script script/DeployArrayStorageMainnet.s.sol:DeployArrayStorageMainnet \
  --rpc-url $MAINNET_RPC_URL \
  --broadcast \
  --verify \
  -vvvv
```

**Deployment includes safety checks:**
- Verifies hardcoded addresses are not test addresses
- Confirms beacon points to implementation
- Confirms factory points to beacon
- Saves deployment info to `deployments/mainnet-{chainId}.json`

#### Step 4: Verify on Etherscan

Contracts should auto-verify with `--verify` flag. If not:

```bash
# Verify Implementation
forge verify-contract \
  --chain-id 1 \
  --compiler-version v0.8.24 \
  $IMPLEMENTATION_ADDRESS \
  src/optimized/UnicitySwapEscrowImplementationArray.sol:UnicitySwapEscrowImplementationArray \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Verify Beacon
forge verify-contract \
  --chain-id 1 \
  --compiler-version v0.8.24 \
  --constructor-args $(cast abi-encode "constructor(address,address)" $IMPLEMENTATION_ADDRESS $DEPLOYER_ADDRESS) \
  $BEACON_ADDRESS \
  src/UnicitySwapEscrowBeacon.sol:UnicitySwapEscrowBeacon \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Verify Factory
forge verify-contract \
  --chain-id 1 \
  --compiler-version v0.8.24 \
  --constructor-args $(cast abi-encode "constructor(address)" $BEACON_ADDRESS) \
  $FACTORY_ADDRESS \
  src/optimized/UnicitySwapEscrowFactoryOptimized.sol:UnicitySwapEscrowFactoryOptimized \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

---

## 5. Post-Deployment Verification

### Automated Verification

The deployment script performs these checks automatically:
- ✅ Beacon points to correct implementation
- ✅ Factory points to correct beacon
- ✅ Hardcoded addresses are not test addresses

### Manual Verification Steps

#### 1. Read Deployed Addresses

```bash
cat deployments/mainnet-1.json  # For Ethereum mainnet
```

#### 2. Verify Implementation

```bash
export IMPL=$(cat deployments/mainnet-1.json | jq -r '.implementation')

cast call $IMPL "escrowOperator()" --rpc-url $MAINNET_RPC_URL
cast call $IMPL "feeRecipient()" --rpc-url $MAINNET_RPC_URL
cast call $IMPL "gasTank()" --rpc-url $MAINNET_RPC_URL
```

**Verify these match your intended addresses.**

#### 3. Verify Beacon

```bash
export BEACON=$(cat deployments/mainnet-1.json | jq -r '.beacon')

cast call $BEACON "implementation()" --rpc-url $MAINNET_RPC_URL
# Should return $IMPL

cast call $BEACON "owner()" --rpc-url $MAINNET_RPC_URL
# Should return deployer address
```

#### 4. Verify Factory

```bash
export FACTORY=$(cat deployments/mainnet-1.json | jq -r '.factory')

cast call $FACTORY "beacon()" --rpc-url $MAINNET_RPC_URL
# Should return $BEACON

cast call $FACTORY "getImplementation()(address)" --rpc-url $MAINNET_RPC_URL
# Should return $IMPL
```

#### 5. Create Test Escrow (Small Amount)

```bash
# Create escrow with minimal values for testing
cast send $FACTORY "createEscrow(address,address,address,uint256,uint256)" \
  $TEST_PAYBACK \
  $TEST_RECIPIENT \
  0x0000000000000000000000000000000000000000 \ # Native currency
  100000000000000000 \  # 0.1 ETH
  300000000000000 \     # 0.0003 ETH fee
  --rpc-url $MAINNET_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY

# Monitor transaction and verify escrow creation event
```

---

## 6. Contract Verification on Etherscan

### Automatic Verification

If deployment used `--verify` flag, contracts should be verified automatically.

### Manual Verification

If automatic verification failed:

1. Go to Etherscan contract page
2. Click "Contract" tab → "Verify and Publish"
3. Select "Solidity (Single File)" or "Solidity (Standard JSON)"
4. Enter:
   - **Compiler Version:** v0.8.24
   - **License:** MIT
   - **Optimization:** Yes (200 runs)
   - **Constructor Arguments:** (if applicable)

5. Upload flattened source:
   ```bash
   forge flatten src/optimized/UnicitySwapEscrowImplementationArray.sol > flattened.sol
   ```

6. Submit for verification

### Verification Checklist

- [ ] Implementation verified on Etherscan
- [ ] Beacon verified on Etherscan
- [ ] Factory verified on Etherscan
- [ ] Source code matches deployment
- [ ] Constructor arguments correct
- [ ] Read/Write functions accessible

---

## 7. Rollback Procedure

### If Deployment Fails

1. **During Deployment:**
   - Transaction will revert automatically
   - No state changes occur
   - Safe to retry after fixing issues

2. **After Deployment (Issues Discovered):**

   **Option A: Deploy New Implementation + Upgrade Beacon**
   ```bash
   # Deploy new fixed implementation
   cast send $NEW_IMPL_ADDRESS "..." --rpc-url $MAINNET_RPC_URL

   # Upgrade beacon (as owner)
   cast send $BEACON "upgradeTo(address)" $NEW_IMPL_ADDRESS \
     --rpc-url $MAINNET_RPC_URL \
     --private-key $BEACON_OWNER_PRIVATE_KEY
   ```

   **Option B: Deploy Entirely New System**
   - Update factory address in backend
   - Keep old factory for existing escrows
   - New escrows use new factory

### Emergency Procedures

**Critical Bug Found:**
1. Immediately update backend to stop creating new escrows
2. Communicate with active users
3. Deploy fixed version
4. Upgrade beacon or deploy new factory
5. Resume operations after verification

**Funds at Risk:**
1. Operator should execute all pending swaps immediately
2. Revert unfunded escrows
3. Deploy fix
4. Resume after security review

---

## 8. Gas Cost Estimates

### Deployment Costs (One-Time)

| Contract | Estimated Gas | @ 20 Gwei | @ 50 Gwei | @ 100 Gwei |
|----------|---------------|-----------|-----------|------------|
| Implementation | ~870,000 | 0.0174 ETH | 0.0435 ETH | 0.087 ETH |
| Beacon | ~177,000 | 0.00354 ETH | 0.00885 ETH | 0.0177 ETH |
| Factory | ~616,000 | 0.01232 ETH | 0.0308 ETH | 0.0616 ETH |
| **TOTAL** | **~1,663,000** | **0.03326 ETH** | **0.08315 ETH** | **0.1663 ETH** |

### Per-Escrow Costs (Recurring)

| Operation | Gas Cost | @ 20 Gwei | @ 50 Gwei | @ 100 Gwei |
|-----------|----------|-----------|-----------|------------|
| Create Escrow | ~116,500 | 0.00233 ETH | 0.005825 ETH | 0.01165 ETH |
| Swap (Native) | ~44,000 | 0.00088 ETH | 0.0022 ETH | 0.0044 ETH |
| Swap (ERC20) | ~39,400 | 0.000788 ETH | 0.00197 ETH | 0.00394 ETH |
| Revert | ~37,000 | 0.00074 ETH | 0.00185 ETH | 0.0037 ETH |

**Gas Savings vs Named Storage:**
- Initialize: 3,900 gas saved (3%)
- Swap (Native): 7,535 gas saved (14%)
- Swap (ERC20): 23,835 gas saved (37%)

---

## 9. Troubleshooting

### Common Issues

#### Issue 1: "Insufficient deployer balance"

**Cause:** Not enough gas in deployer account
**Solution:** Fund deployer with at least 0.5 ETH (mainnet) or 0.1 ETH (testnet)

#### Issue 2: "SECURITY: ESCROW_OPERATOR is test address!"

**Cause:** Hardcoded addresses not updated
**Solution:** Edit `UnicitySwapEscrowImplementationArray.sol` lines 34-40, then rebuild

#### Issue 3: Verification fails on Etherscan

**Cause:** Constructor arguments or optimizer settings mismatch
**Solution:**
```bash
forge flatten src/optimized/UnicitySwapEscrowImplementationArray.sol > flattened.sol
# Manually verify using flattened source
# Ensure optimizer enabled with 200 runs
```

#### Issue 4: "Beacon implementation mismatch"

**Cause:** Beacon not properly initialized
**Solution:** Verify beacon deployment:
```bash
cast call $BEACON "implementation()" --rpc-url $RPC_URL
# Should match implementation address
```

#### Issue 5: Factory creation fails

**Cause:** Invalid beacon address or insufficient gas
**Solution:** Verify beacon address and increase gas limit:
```bash
forge script ... --gas-limit 3000000
```

### Getting Help

- **Security Issues:** email security@unicity.io
- **Deployment Issues:** Check Foundry docs or Discord
- **Contract Questions:** Review ARRAY_STORAGE_SECURITY_AUDIT.md

---

## Appendix A: Complete Deployment Command Reference

### Testnet (Sepolia)
```bash
forge script script/DeployArrayStorageTestnet.s.sol:DeployArrayStorageTestnet \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  -vvvv
```

### Mainnet (Ethereum)
```bash
forge script script/DeployArrayStorageMainnet.s.sol:DeployArrayStorageMainnet \
  --rpc-url $MAINNET_RPC_URL \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --legacy \  # Use if EIP-1559 issues
  -vvvv
```

### Polygon
```bash
forge script script/DeployArrayStorageMainnet.s.sol:DeployArrayStorageMainnet \
  --rpc-url $POLYGON_RPC_URL \
  --broadcast \
  --verify \
  --etherscan-api-key $POLYGONSCAN_API_KEY \
  --legacy \
  -vvvv
```

---

## Appendix B: Post-Deployment Integration

### Backend Configuration

After successful deployment, update your backend configuration:

```typescript
// Backend config
const ESCROW_CONFIG = {
  chainId: 1, // Ethereum mainnet
  factoryAddress: "0x...", // From deployments/mainnet-1.json
  operatorPrivateKey: process.env.OPERATOR_PRIVATE_KEY,
  rpcUrl: process.env.MAINNET_RPC_URL
};
```

### Monitoring Setup

Monitor these events:
- `EscrowCreated` - New escrow instances
- `StateTransition` - Escrow state changes
- `SwapExecuted` - Successful swaps
- `Reverted` - Cancelled swaps

### First Production Swap

1. Create escrow with minimal amount ($10-100)
2. Fund escrow
3. Execute swap
4. Verify all transfers occurred correctly
5. Monitor gas costs
6. Gradually increase to normal amounts

---

**End of Deployment Guide**

For security audit details, see: `/home/vrogojin/otc_agent/contracts/ARRAY_STORAGE_SECURITY_AUDIT.md`

For pre-deployment checklist, see: `/home/vrogojin/otc_agent/contracts/HARDCODED_CONSTANTS_CHECKLIST.md`
