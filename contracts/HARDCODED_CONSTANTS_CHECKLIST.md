# Hardcoded Constants Pre-Deployment Checklist

**⚠️ CRITICAL: Complete this checklist BEFORE mainnet deployment**

**Contract:** UnicitySwapEscrowImplementationArray.sol
**File Location:** `/home/vrogojin/otc_agent/contracts/src/optimized/UnicitySwapEscrowImplementationArray.sol`

---

## Overview

The escrow implementation uses hardcoded constants for gas optimization. These MUST be updated before mainnet deployment.

**Current Test Values (MUST CHANGE):**
- `ESCROW_OPERATOR`: `0x0000000000000000000000000000000000000001`
- `FEE_RECIPIENT`: `0x0000000000000000000000000000000000000002`
- `GAS_TANK`: `0x0000000000000000000000000000000000000003`

---

## Checklist: Update Hardcoded Constants

### Step 1: Gather Production Addresses

Fill in your production addresses:

```
ESCROW_OPERATOR (Backend Service Wallet):
[ ] Address: 0x_______________________________________
[ ] Private key securely stored: ___________________
[ ] Accessible by backend: _________________________
[ ] Verified on block explorer: ____________________

FEE_RECIPIENT (Fee Collection Wallet):
[ ] Address: 0x_______________________________________
[ ] Type: EOA / Multisig / Contract (circle one)
[ ] If multisig, signers verified: _________________
[ ] Controlled by organization: ____________________

GAS_TANK (Gas Refund Wallet):
[ ] Address: 0x_______________________________________
[ ] Type: EOA / Multisig / Contract (circle one)
[ ] Controlled by organization: ____________________
[ ] Can be same as FEE_RECIPIENT: __________________
```

### Step 2: Update Contract Source Code

Edit file: `/home/vrogojin/otc_agent/contracts/src/optimized/UnicitySwapEscrowImplementationArray.sol`

**Lines to modify: 34-40**

**Before (TEST VALUES - DO NOT DEPLOY):**
```solidity
/// @notice Backend operator address - MUST BE CONFIGURED BEFORE DEPLOYMENT
address internal constant ESCROW_OPERATOR = 0x0000000000000000000000000000000000000001; // TODO: REPLACE WITH REAL ADDRESS

/// @notice Fee recipient address - MUST BE CONFIGURED BEFORE DEPLOYMENT
address payable internal constant FEE_RECIPIENT = payable(0x0000000000000000000000000000000000000002); // TODO: REPLACE WITH REAL ADDRESS

/// @notice Gas tank address - MUST BE CONFIGURED BEFORE DEPLOYMENT
address payable internal constant GAS_TANK = payable(0x0000000000000000000000000000000000000003); // TODO: REPLACE WITH REAL ADDRESS
```

**After (YOUR PRODUCTION VALUES):**
```solidity
/// @notice Backend operator address - CONFIGURED FOR PRODUCTION
address internal constant ESCROW_OPERATOR = 0xYOUR_OPERATOR_ADDRESS_HERE;

/// @notice Fee recipient address - CONFIGURED FOR PRODUCTION
address payable internal constant FEE_RECIPIENT = payable(0xYOUR_FEE_RECIPIENT_HERE);

/// @notice Gas tank address - CONFIGURED FOR PRODUCTION
address payable internal constant GAS_TANK = payable(0xYOUR_GAS_TANK_HERE);
```

**Checklist:**
- [ ] Opened UnicitySwapEscrowImplementationArray.sol
- [ ] Located lines 34-40
- [ ] Replaced ESCROW_OPERATOR with production address
- [ ] Replaced FEE_RECIPIENT with production address
- [ ] Replaced GAS_TANK with production address
- [ ] Removed "TODO" comments
- [ ] Saved file

### Step 3: Verify Changes

Run verification script:

```bash
cd /home/vrogojin/otc_agent/contracts
grep -n "ESCROW_OPERATOR\|FEE_RECIPIENT\|GAS_TANK" src/optimized/UnicitySwapEscrowImplementationArray.sol
```

**Expected output (with YOUR addresses):**
```
34:    address internal constant ESCROW_OPERATOR = 0xYOUR_ADDRESS;
37:    address payable internal constant FEE_RECIPIENT = payable(0xYOUR_ADDRESS);
40:    address payable internal constant GAS_TANK = payable(0xYOUR_ADDRESS);
```

**Safety Checks - MUST ALL BE TRUE:**
- [ ] ESCROW_OPERATOR is NOT `0x0000000000000000000000000000000000000001`
- [ ] FEE_RECIPIENT is NOT `0x0000000000000000000000000000000000000002`
- [ ] GAS_TANK is NOT `0x0000000000000000000000000000000000000003`
- [ ] All addresses start with `0x` and are 42 characters long
- [ ] All addresses are checksummed (proper case)
- [ ] All addresses are controlled by your organization

### Step 4: Rebuild and Test

Rebuild contracts:
```bash
forge clean
forge build
```

Run tests to ensure changes didn't break anything:
```bash
forge test --match-path test/optimized/ArrayStorageSecurityTest.t.sol -vv
```

**Expected:** All 28 tests pass (some may need address updates in tests).

**Checklist:**
- [ ] Contracts compile successfully
- [ ] No compiler warnings about constants
- [ ] Security tests still pass
- [ ] Gas tests still pass

---

## Address Validation Rules

### ESCROW_OPERATOR Requirements

- [ ] **Must be EOA (Externally Owned Account)** - Contract addresses cannot sign transactions
- [ ] **Private key must be accessible by backend** - Backend needs to call `swap()` and `revertEscrow()`
- [ ] **Should be dedicated wallet** - Don't reuse for other purposes
- [ ] **Must have native currency for gas** - Operator pays gas for swap/revert calls
- [ ] **Recommend using hardware wallet or HSM** - For production security

**Backend Integration Test:**
```typescript
// Verify backend can sign transactions as operator
const tx = await escrow.swap({ from: ESCROW_OPERATOR });
```

### FEE_RECIPIENT Requirements

- [ ] **Can be EOA, Multisig, or Contract** - Any address that can receive tokens/ETH
- [ ] **Must be secure** - Will accumulate protocol fees over time
- [ ] **Recommend using multisig** - Gnosis Safe with 2-of-3 or 3-of-5
- [ ] **Test token reception** - Ensure can receive ERC20 and native currency
- [ ] **Document recovery process** - If keys lost

**Security Recommendation:**
Use Gnosis Safe multisig with these signers:
1. CEO/Founder
2. CTO/Technical Lead
3. CFO/Operations Lead

Require 2-of-3 signatures for withdrawals.

### GAS_TANK Requirements

- [ ] **Can be same as FEE_RECIPIENT** - Simplifies treasury management
- [ ] **Or separate wallet** - If you want to track gas refunds separately
- [ ] **Must be able to receive native currency** - Receives gas refunds
- [ ] **Consider automated monitoring** - Alert if balance gets too high (inefficiency)

**Options:**
1. **Same as FEE_RECIPIENT:** Simpler, all protocol revenue in one place
2. **Separate wallet:** Better accounting, can track gas costs separately
3. **Treasury contract:** Automated distribution of funds

---

## Environment-Specific Checklists

### For Testnet Deployment

**Testnet (Sepolia, Mumbai, etc.):**
- [ ] Can use test addresses (0x1, 0x2, 0x3) - OK for testing
- [ ] Or use production addresses - Better for integration testing
- [ ] Document which approach you chose
- [ ] Ensure backend connects to correct network

### For Mainnet Deployment

**Mainnet (Ethereum, Polygon, Arbitrum, etc.):**
- [ ] ⚠️ MUST use production addresses - No test addresses allowed
- [ ] All addresses verified on block explorer
- [ ] Private keys securely stored in HSM or hardware wallet
- [ ] Access control documented
- [ ] Recovery procedures documented
- [ ] Team members trained on security procedures

---

## Pre-Deployment Double-Check

**STOP! Before deploying to mainnet, verify ALL of the following:**

### Code Review Checklist

- [ ] Opened `UnicitySwapEscrowImplementationArray.sol`
- [ ] Line 34: ESCROW_OPERATOR = **[Write address here: ________________]**
- [ ] Line 37: FEE_RECIPIENT = **[Write address here: ________________]**
- [ ] Line 40: GAS_TANK = **[Write address here: ________________]**
- [ ] All three addresses are different from test addresses
- [ ] All three addresses are checksummed
- [ ] Saved file and compiled successfully

### Security Checklist

- [ ] ESCROW_OPERATOR private key stored in: **[HSM / Hardware Wallet / KMS]**
- [ ] FEE_RECIPIENT is: **[EOA / Multisig / Contract]** (circle one)
- [ ] If multisig, signers are: **[List names/roles: ________________]**
- [ ] All addresses have been tested on testnet
- [ ] Access control policies documented
- [ ] Key recovery procedures documented

### Team Approval

- [ ] Technical Lead reviewed: **[Name: _______ Date: _______]**
- [ ] Security Lead reviewed: **[Name: _______ Date: _______]**
- [ ] Executive approval: **[Name: _______ Date: _______]**

---

## Deployment Script Verification

The deployment scripts include automatic checks:

### DeployArrayStorageMainnet.s.sol Safety Checks

```solidity
// Automatically checks these conditions:
require(operator != address(0x0000000000000000000000000000000000000001),
    "SECURITY: ESCROW_OPERATOR is test address!");
require(feeRecipient != address(0x0000000000000000000000000000000000000002),
    "SECURITY: FEE_RECIPIENT is test address!");
require(gasTank != address(0x0000000000000000000000000000000000000003),
    "SECURITY: GAS_TANK is test address!");
```

**If deployment fails with "SECURITY: X is test address":**
1. You forgot to update hardcoded constants
2. Return to Step 2 of this checklist
3. Update addresses and rebuild

---

## Post-Deployment Verification

After deployment, verify addresses are correct:

```bash
# Read deployed implementation address
IMPL=$(cat deployments/mainnet-1.json | jq -r '.implementation')

# Verify ESCROW_OPERATOR
cast call $IMPL "escrowOperator()" --rpc-url $MAINNET_RPC_URL
# Should output: 0xYOUR_OPERATOR_ADDRESS

# Verify FEE_RECIPIENT
cast call $IMPL "feeRecipient()" --rpc-url $MAINNET_RPC_URL
# Should output: 0xYOUR_FEE_RECIPIENT

# Verify GAS_TANK
cast call $IMPL "gasTank()" --rpc-url $MAINNET_RPC_URL
# Should output: 0xYOUR_GAS_TANK
```

**Post-Deployment Checklist:**
- [ ] ESCROW_OPERATOR matches expected address
- [ ] FEE_RECIPIENT matches expected address
- [ ] GAS_TANK matches expected address
- [ ] All addresses accessible by organization
- [ ] Backend can send transactions as operator
- [ ] Monitoring set up for fee accumulation

---

## Common Mistakes to Avoid

### ❌ Mistake 1: Deploying with test addresses
**Consequence:** Funds sent to addresses you don't control
**Solution:** Complete this checklist before deployment

### ❌ Mistake 2: Using contract address for ESCROW_OPERATOR
**Consequence:** Operator cannot sign transactions (swap/revert will fail)
**Solution:** Use EOA with accessible private key

### ❌ Mistake 3: Losing FEE_RECIPIENT private keys
**Consequence:** Protocol fees locked forever
**Solution:** Use multisig with multiple signers and documented recovery

### ❌ Mistake 4: Not testing addresses on testnet first
**Consequence:** Discover issues on mainnet (expensive)
**Solution:** Deploy to testnet with production addresses first

### ❌ Mistake 5: Forgetting to rebuild after updating constants
**Consequence:** Deploy old version with test addresses
**Solution:** Always run `forge clean && forge build` after changes

---

## Emergency Contact Information

If you discover hardcoded constants are wrong AFTER deployment:

### Option 1: Upgrade via Beacon (Recommended)

1. Deploy new implementation with correct addresses
2. Upgrade beacon to point to new implementation
3. All existing escrows now use new addresses
4. Requires beacon owner private key

### Option 2: Deploy New System

1. Deploy entirely new factory + beacon + implementation
2. Update backend to use new factory for new escrows
3. Old escrows continue using old addresses
4. More expensive but safer

### Getting Help

- **Security Issues:** security@unicity.io
- **Deployment Issues:** Deploy to testnet first, then retry
- **Address Recovery:** If using multisig, contact signers immediately

---

## Final Sign-Off

**I certify that I have:**

- [ ] Read this entire checklist
- [ ] Updated all three hardcoded constants
- [ ] Verified addresses are NOT test addresses
- [ ] Compiled and tested with new addresses
- [ ] Backed up all private keys securely
- [ ] Documented access control procedures
- [ ] Obtained necessary approvals
- [ ] Ready to deploy to mainnet

**Signature:** _______________________  **Date:** __________

**Witness:** _______________________  **Date:** __________

---

**After completing this checklist, proceed to DEPLOYMENT_GUIDE.md**

---

## Appendix: Address Validation Script

Save this as `verify_addresses.sh` and run before deployment:

```bash
#!/bin/bash
# Verify hardcoded constants are not test addresses

IMPL_FILE="src/optimized/UnicitySwapEscrowImplementationArray.sol"

echo "Checking hardcoded constants..."

# Extract addresses
OPERATOR=$(grep "ESCROW_OPERATOR =" $IMPL_FILE | sed 's/.*= \(0x[^;]*\);.*/\1/')
FEE_RECIP=$(grep "FEE_RECIPIENT =" $IMPL_FILE | sed 's/.*= payable(\(0x[^)]*\)).*/\1/')
GAS_TANK=$(grep "GAS_TANK =" $IMPL_FILE | sed 's/.*= payable(\(0x[^)]*\)).*/\1/')

echo "ESCROW_OPERATOR: $OPERATOR"
echo "FEE_RECIPIENT: $FEE_RECIP"
echo "GAS_TANK: $GAS_TANK"

# Check for test addresses
if [ "$OPERATOR" == "0x0000000000000000000000000000000000000001" ]; then
    echo "❌ ERROR: ESCROW_OPERATOR is test address!"
    exit 1
fi

if [ "$FEE_RECIP" == "0x0000000000000000000000000000000000000002" ]; then
    echo "❌ ERROR: FEE_RECIPIENT is test address!"
    exit 1
fi

if [ "$GAS_TANK" == "0x0000000000000000000000000000000000000003" ]; then
    echo "❌ ERROR: GAS_TANK is test address!"
    exit 1
fi

echo "✅ All addresses verified - ready for deployment!"
```

Run before deploying:
```bash
chmod +x verify_addresses.sh
./verify_addresses.sh
```

---

**END OF CHECKLIST**

**Remember: These constants are immutable after deployment. Double-check everything!**
