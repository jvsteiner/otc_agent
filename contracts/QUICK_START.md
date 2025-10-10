# UnicitySwapEscrow Quick Start Guide

Get started with UnicitySwapEscrow in 5 minutes.

---

## Prerequisites

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

---

## Setup

```bash
cd contracts
forge install
forge build
forge test
```

---

## Basic Usage

### 1. Deploy Factory

```bash
forge script script/Deploy.s.sol:DeployScript \
    --rpc-url $RPC_URL \
    --broadcast
```

### 2. Create Escrow

```solidity
// JavaScript/TypeScript
const factory = new ethers.Contract(factoryAddress, factoryABI, signer);

const tx = await factory.createEscrow(
    operatorAddress,        // Who can execute swap
    ethers.utils.id("DEAL_001"),  // Unique deal ID
    aliceAddress,          // Refund address
    bobAddress,            // Swap recipient
    operatorAddress,       // Fee recipient
    treasuryAddress,       // Gas tank
    tokenAddress,          // ERC20 or ethers.constants.AddressZero for ETH
    ethers.utils.parseEther("10"),    // Swap amount
    ethers.utils.parseEther("0.1")    // Fee amount
);

const receipt = await tx.wait();
const escrowAddress = receipt.events[0].args.escrow;
```

### 3. Deposit Funds

```solidity
// For ERC20
const token = new ethers.Contract(tokenAddress, erc20ABI, signer);
await token.transfer(escrowAddress, amount);

// For ETH
await signer.sendTransaction({
    to: escrowAddress,
    value: ethers.utils.parseEther("10.1")
});
```

### 4. Execute Swap

```solidity
const escrow = new ethers.Contract(escrowAddress, escrowABI, operatorSigner);

// Check if ready
const canSwap = await escrow.canSwap();
console.log("Ready to swap:", canSwap);

// Execute
await escrow.swap();
```

---

## Common Operations

### Check Status

```solidity
const state = await escrow.state();
const states = ["COLLECTION", "SWAP", "COMPLETED", "REVERTED"];
console.log("Current state:", states[state]);
```

### Check Balance

```solidity
const balance = await escrow.getBalance();
console.log("Escrow balance:", ethers.utils.formatEther(balance));
```

### Revert Deal

```solidity
await escrow.revertEscrow();
```

### Refund Surplus

```solidity
await escrow.refund();
```

### Sweep Accidental Tokens

```solidity
await escrow.sweep(otherTokenAddress);
```

---

## Events

Listen for events:

```solidity
escrow.on("StateTransition", (from, to) => {
    console.log(`State changed from ${from} to ${to}`);
});

escrow.on("SwapExecuted", (recipient, swapValue, feeValue) => {
    console.log(`Swap executed: ${ethers.utils.formatEther(swapValue)} to ${recipient}`);
});
```

---

## Testing

```bash
# All tests
forge test

# Specific test
forge test --match-test test_Swap_Success

# With gas report
forge test --gas-report

# With coverage
forge coverage
```

---

## Deployment Networks

### Ethereum Mainnet
```bash
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
```

### Polygon
```bash
RPC_URL=https://polygon-rpc.com
```

### Arbitrum
```bash
RPC_URL=https://arb1.arbitrum.io/rpc
```

### Base
```bash
RPC_URL=https://mainnet.base.org
```

---

## Security Checklist

Before mainnet deployment:

- [ ] Test on testnet first
- [ ] Verify contract on Etherscan
- [ ] Use multi-sig for operator
- [ ] Set up monitoring
- [ ] Prepare incident response
- [ ] Document deployed addresses
- [ ] Test with small amounts first

---

## Common Errors

### "UnauthorizedOperator()"
- Only operator can call `swap()` or `revertEscrow()`
- Check you're using correct signer

### "InvalidState()"
- Wrong state for operation
- Check current state with `escrow.state()`

### "InsufficientBalance()"
- Not enough funds to execute swap
- Check balance with `escrow.getBalance()`
- Ensure swapValue + feeValue is available

### "AlreadyExecuted()"
- Swap already executed
- Cannot execute twice
- Check with `escrow.isSwapExecuted()`

---

## Gas Estimates

| Operation | Gas Cost | ETH @ 20 Gwei |
|-----------|----------|---------------|
| Deploy Escrow | 900K | 0.018 ETH |
| swap() | 138K | 0.0028 ETH |
| revert() | 137K | 0.0027 ETH |
| refund() | 30K | 0.0006 ETH |

---

## Support

- **Documentation:** [README.md](./README.md)
- **Audit Report:** [audit/AUDIT_REPORT.md](./audit/AUDIT_REPORT.md)
- **Security:** security@unicity.io

---

## Example: Complete Flow

```solidity
// 1. Deploy factory
const Factory = await ethers.getContractFactory("UnicitySwapEscrowFactory");
const factory = await Factory.deploy();

// 2. Create escrow
const tx = await factory.createEscrow(
    operator.address,
    ethers.utils.id("DEAL_001"),
    alice.address,
    bob.address,
    operator.address,
    treasury.address,
    ethers.constants.AddressZero, // ETH
    ethers.utils.parseEther("10"),
    ethers.utils.parseEther("0.1")
);

const receipt = await tx.wait();
const escrowAddress = receipt.events[0].args.escrow;
const escrow = await ethers.getContractAt("UnicitySwapEscrow", escrowAddress);

// 3. Alice deposits
await alice.sendTransaction({
    to: escrowAddress,
    value: ethers.utils.parseEther("10.1")
});

// 4. Check status
console.log("Can swap:", await escrow.canSwap()); // true

// 5. Operator executes
await escrow.connect(operator).swap();

// 6. Verify
console.log("Bob balance:", await ethers.provider.getBalance(bob.address));
console.log("Operator fee:", await ethers.provider.getBalance(operator.address));
```

---

**Ready to deploy!** See [README.md](./README.md) for complete documentation.
