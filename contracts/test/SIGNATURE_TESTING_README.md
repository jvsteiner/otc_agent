# Signature Verification Testing Guide

## Quick Start

### Running Tests

```bash
# 1. Run Solidity signature tests
cd contracts
forge test --match-contract SignatureVerificationTest -vv

# 2. Run TypeScript unit tests
cd packages/chains
npm run test:unit

# 3. Run TypeScript integration tests (requires anvil)
cd packages/chains
npm run test:integration

# 4. Run all tests
./run_signature_tests.sh
```

## Test Files

### 1. Solidity Reference Tests
**File**: `contracts/test/SignatureVerification.t.sol`

**Purpose**:
- Generate reference signatures using Foundry's `vm.sign()`
- Verify signatures work with actual contract
- Export test vectors for TypeScript verification

**Key Tests**:
- `test_SignatureVector_Basic()` - Basic signature generation
- `test_SignatureVector_ZeroFees()` - Zero fees scenario
- `test_SignatureVector_LargeAmounts()` - Large ETH amounts
- `test_SignatureVector_DifferentCallers()` - Different escrow addresses
- `test_SignatureVector_Revert()` - Revert operation
- `test_SignatureRecovery_Manual()` - Manual signature recovery demo

**Run specific test**:
```bash
forge test --match-test test_SignatureVector_Basic -vv
```

### 2. TypeScript Unit Tests
**File**: `packages/chains/test/EvmPlugin.signature.test.ts`

**Purpose**:
- Verify TypeScript signature generation matches Solidity
- Compare byte-for-byte against reference signatures
- Test edge cases and signature properties

**Key Tests**:
- Test Vector validation (all 6 reference signatures)
- Signature recovery verification
- Determinism checks
- Edge cases (small amounts, special characters, checksum addresses)

**Run specific test**:
```bash
npm test -- --testNamePattern="should generate correct signature for basic case"
```

### 3. TypeScript Integration Tests
**File**: `packages/chains/test/EvmPlugin.integration.test.ts`

**Purpose**:
- End-to-end verification with live contract
- Deploy UnicitySwapBroker to local Anvil
- Call contract functions with TypeScript-generated signatures
- Verify transactions succeed

**Key Tests**:
- Contract deployment
- SwapNative with various scenarios
- RevertNative operations
- Security tests (wrong caller, modified parameters)

**Requirements**:
- Anvil running (started automatically)
- Contract artifacts built (`forge build`)

## Test Vectors

All tests use consistent test vectors:

```typescript
OPERATOR_PRIVATE_KEY = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
OPERATOR_ADDRESS     = '0x1Be31A94361a391bBaFB2a4CCd704F57dc04d4bb'
ESCROW_EOA          = '0x1111111111111111111111111111111111111111'
PAYBACK             = '0x2222222222222222222222222222222222222222'
RECIPIENT           = '0x3333333333333333333333333333333333333333'
FEE_RECIPIENT       = '0x4444444444444444444444444444444444444444'
```

## Adding New Tests

### 1. Add Solidity Test

```solidity
function test_SignatureVector_YourScenario() public {
    bytes32 dealId = keccak256("YOUR_DEAL");
    uint256 amount = 1 ether;
    uint256 fees = 0.01 ether;

    bytes memory signature = sigHelper.signSwapNative(
        operatorPrivateKey,
        address(broker),
        dealId,
        payback,
        recipient,
        feeRecipient,
        amount,
        fees,
        escrowEOA
    );

    // Log signature for TypeScript reference
    console.log("Signature:");
    console.logBytes(signature);

    // Verify it works with contract
    vm.prank(escrowEOA);
    broker.swapNative{value: totalAmount}(
        dealId, payback, recipient, feeRecipient,
        amount, fees, signature
    );
}
```

### 2. Add TypeScript Test

```typescript
it('should match Solidity signature for your scenario', () => {
    const dealId = 'YOUR_DEAL';
    const amount = '1.0';
    const fees = '0.01';

    const signature = generateOperatorSignature(
        dealId, PAYBACK, RECIPIENT, FEE_RECIPIENT,
        amount, fees, ESCROW_EOA
    );

    // Reference signature from Solidity test
    const expectedSignature = '0x...'; // Copy from Solidity logs

    expect(signature.toLowerCase()).toBe(expectedSignature.toLowerCase());
});
```

### 3. Add Integration Test

```typescript
it('should accept signature for your scenario', async () => {
    const dealId = 'YOUR_DEAL';
    const amount = '1.0';
    const fees = '0.01';
    const totalAmount = ethers.parseEther('1.5');

    const signature = generateSwapSignature(
        dealId, PAYBACK, RECIPIENT, FEE_RECIPIENT,
        amount, fees, escrowWallet.address
    );

    const tx = await broker.connect(escrowWallet)
        .swapNative(
            ethers.id(dealId), PAYBACK, RECIPIENT, FEE_RECIPIENT,
            ethers.parseEther(amount), ethers.parseEther(fees),
            signature, { value: totalAmount }
        );

    const receipt = await tx.wait();
    expect(receipt.status).toBe(1);
});
```

## Troubleshooting

### Signature Mismatch

If TypeScript signature doesn't match Solidity:

1. **Check broker address**: Must be identical in both tests
2. **Check parameter order**: Must match contract exactly
3. **Check amount conversion**: Both must use wei (not ether)
4. **Check dealId hashing**: Both must use keccak256(string)
5. **Check message prefix**: Both must apply Ethereum Signed Message

### Contract Rejects Signature

If integration test fails with "InvalidSignature":

1. **Check caller address**: Signature binds to `msg.sender`
2. **Check parameters**: All must match exactly
3. **Check operator**: Private key must match contract's operator
4. **Check nonce**: Each dealId can only be used once

### Anvil Issues

If integration tests timeout:

1. Check Anvil is installed: `/home/vrogojin/.foundry/bin/anvil --version`
2. Check port 8545 is available: `lsof -i :8545`
3. Increase timeout in jest.config.js
4. Check contract artifacts exist: `forge build`

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Signature Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2

      - name: Install Foundry
        uses: foundry-rs/foundry-toolchain@v1

      - name: Install Node.js
        uses: actions/setup-node@v2
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install

      - name: Build contracts
        run: cd contracts && forge build

      - name: Run Solidity tests
        run: cd contracts && forge test --match-contract SignatureVerificationTest

      - name: Run TypeScript unit tests
        run: cd packages/chains && npm run test:unit

      - name: Run TypeScript integration tests
        run: cd packages/chains && npm run test:integration
```

## Performance

- **Solidity tests**: ~2ms total
- **TypeScript unit tests**: ~1s total
- **TypeScript integration tests**: ~40s total (includes contract deployment)

## Maintenance

### When to Update Tests

Update tests when:
- Modifying signature generation logic
- Changing contract signature verification
- Adding new signature scenarios
- Updating ethers.js or Solidity version

### Test Coverage Goals

Maintain 100% coverage for:
- All signature generation code paths
- All parameter combinations
- All edge cases (zero values, max values, special characters)
- All security scenarios (wrong caller, modified params, wrong operator)

## Additional Resources

- **Full Report**: `/home/vrogojin/otc_agent/SIGNATURE_VERIFICATION_REPORT.md`
- **Contract**: `/home/vrogojin/otc_agent/contracts/src/UnicitySwapBroker.sol`
- **Backend**: `/home/vrogojin/otc_agent/packages/chains/src/EvmPlugin.ts`
- **Signature Helper**: `/home/vrogojin/otc_agent/contracts/test/SignatureHelper.sol`
