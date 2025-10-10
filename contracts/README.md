# UnicitySwapEscrow - Production-Grade OTC Swap Escrow Contracts

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.24-blue)](https://soliditylang.org)
[![Foundry](https://img.shields.io/badge/Built%20with-Foundry-000000)](https://getfoundry.sh/)

Production-ready smart contracts for secure cross-chain OTC swaps with atomic execution guarantees.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Features](#features)
- [Security](#security)
- [Installation](#installation)
- [Usage](#usage)
- [Testing](#testing)
- [Deployment](#deployment)
- [Gas Estimates](#gas-estimates)
- [Contract API](#contract-api)
- [Examples](#examples)
- [Security Considerations](#security-considerations)
- [License](#license)

---

## Overview

**UnicitySwapEscrow** is a battle-tested escrow contract system designed for cross-chain OTC (Over-The-Counter) swaps. It provides secure custody of assets with operator-controlled swap execution or reversion.

### Key Characteristics

- **Atomic Operations:** All swap operations execute in a single transaction
- **State Machine:** Enforced state transitions prevent invalid operations
- **Immutable Parameters:** Security-critical values set at deployment
- **Multi-Currency:** Supports both native ETH and ERC20 tokens
- **Gas Optimized:** Efficient bytecode and storage layout
- **Thoroughly Tested:** 39+ tests including security and fuzz tests

---

## Architecture

### Contract Structure

```
UnicitySwapEscrow (Core)
├── State Machine: COLLECTION → SWAP → COMPLETED
│                           └→ REVERTED
├── Access Control: Operator-only swap/revert
├── Re-entrancy Protection: OpenZeppelin ReentrancyGuard
└── Safe Transfers: SafeERC20 for tokens, checked native transfers

UnicitySwapEscrowFactory
├── Direct Deployment: Simple new() pattern
├── CREATE2 Support: Deterministic addresses
└── Event Emission: EscrowCreated events

UnicitySwapEscrowBeacon (Optional)
└── Upgradeable Pattern: For future upgrades (if needed)
```

### State Machine

```
COLLECTION (Initial)
    |
    ├─── swap() ────→ SWAP ────→ COMPLETED
    |
    └─ revertEscrow() ──────────→ REVERTED
```

---

## Features

### Core Features

- Operator-Controlled Execution
- Atomic State Transitions
- Multi-Currency Support (Native + ERC20)
- Surplus Handling and Refunds
- Double-Execution Protection
- Re-entrancy Protection
- Gas Optimized
- Event Emission

### Security Features

- OpenZeppelin ReentrancyGuard
- Checks-Effects-Interactions pattern
- SafeERC20 for token transfers
- Immutable critical parameters
- Custom errors for gas efficiency

---

## Security

**Security Audit:** Comprehensive audit completed. See [audit/AUDIT_REPORT.md](./audit/AUDIT_REPORT.md)

**Overall Rating:** HIGH 🟢

**Protections:**
- Re-entrancy attacks
- Double-swap prevention
- Unauthorized access
- Integer overflow/underflow
- Unchecked token transfers
- State manipulation

---

## Installation

### Prerequisites
- [Foundry](https://getfoundry.sh/)

### Setup

```bash
# Clone repository
git clone <repository-url>
cd contracts

# Install dependencies
forge install

# Build contracts
forge build

# Run tests
forge test

# Check coverage
forge coverage
```

---

## Usage

### Creating an Escrow

#### Via Factory

```solidity
UnicitySwapEscrowFactory factory = UnicitySwapEscrowFactory(factoryAddress);

address escrow = factory.createEscrow(
    operator,           // Address authorized to swap/revert
    dealID,            // Unique deal identifier
    payback,           // Refund destination
    recipient,         // Swap recipient
    feeRecipient,      // Fee destination
    gasTank,           // Sweep destination
    currency,          // ERC20 or address(0) for ETH
    swapValue,         // Amount to swap
    feeValue           // Operator fee
);
```

#### Direct Deployment

```solidity
UnicitySwapEscrow escrow = new UnicitySwapEscrow(
    operator,
    dealID,
    payback,
    recipient,
    feeRecipient,
    gasTank,
    currency,
    swapValue,
    feeValue
);
```

### Depositing Funds

```solidity
// For ERC20
IERC20(token).transfer(escrowAddress, amount);

// For native ETH
(bool success, ) = escrowAddress.call{value: amount}("");
```

### Executing Swap

```solidity
// Only operator
escrow.swap();
```

### Reverting Escrow

```solidity
// Only operator
escrow.revertEscrow();
```

---

## Testing

### Run All Tests

```bash
forge test
```

### Run with Verbosity

```bash
forge test -vv       # Standard
forge test -vvv      # Traces for failures
forge test -vvvv     # All traces
```

### Coverage

```bash
forge coverage
```

### Gas Report

```bash
forge test --gas-report
```

---

## Deployment

### Setup Environment

Create `.env`:

```bash
PRIVATE_KEY=your_private_key
RPC_URL=https://your-rpc-url
ETHERSCAN_API_KEY=your_api_key
```

### Deploy Factory

```bash
forge script script/Deploy.s.sol:DeployScript \
    --rpc-url $RPC_URL \
    --broadcast \
    --verify
```

---

## Gas Estimates

### Deployment
- Direct: ~900,000 gas
- Factory: ~920,000 gas

### Operations
- swap(): ~138,000 gas (ERC20), ~120,000 gas (native)
- revertEscrow(): ~137,000 gas
- refund(): ~30,000 gas
- sweep(): ~40,000 gas

---

## Contract API

### State-Changing Functions

```solidity
function swap() external;
function revertEscrow() external;
function refund() external;
function sweep(address currency) external;
```

### View Functions

```solidity
function canSwap() public view returns (bool);
function getBalance() external view returns (uint256);
function isSwapExecuted() external view returns (bool);
```

### Public Variables

```solidity
address public immutable escrowOperator;
bytes32 public immutable dealID;
address payable public immutable payback;
address payable public immutable recipient;
address payable public immutable feeRecipient;
address payable public immutable gasTank;
address public immutable currency;
uint256 public immutable swapValue;
uint256 public immutable feeValue;
State public state;
```

---

## Examples

### ETH Swap

```solidity
UnicitySwapEscrow escrow = new UnicitySwapEscrow(
    operator, keccak256("DEAL_001"), payable(alice), payable(bob),
    payable(operator), payable(treasury), address(0), 10 ether, 0.1 ether
);

alice.call{value: 10.1 ether}(address(escrow));
escrow.swap(); // Bob gets 10 ETH, operator gets 0.1 ETH
```

### ERC20 Swap

```solidity
IERC20 usdc = IERC20(usdcAddress);

UnicitySwapEscrow escrow = new UnicitySwapEscrow(
    operator, keccak256("DEAL_002"), payable(alice), payable(bob),
    payable(operator), payable(treasury), address(usdc), 1000e6, 10e6
);

usdc.transfer(address(escrow), 1010e6);
escrow.swap(); // Bob gets 1000 USDC, operator gets 10 USDC
```

---

## Security Considerations

### Operator Trust
- Operator has full control over execution
- Use multi-sig for operator role
- Consider Gnosis Safe

### Immutability
- All parameters immutable after deployment
- Cannot change recipient, amounts, or operator

### Re-entrancy
- Protected with OpenZeppelin ReentrancyGuard
- CEI pattern enforced

### Front-running
- Minimal impact: surplus goes to payback
- No value extraction possible

---

## License

MIT License - see LICENSE file

---

## Support

- GitHub Issues: Create an issue
- Security: security@unicity.io

---

## Acknowledgments

- [Foundry](https://getfoundry.sh/)
- [OpenZeppelin](https://openzeppelin.com/)
- [Solidity](https://soliditylang.org/)

---

**⚠️ DISCLAIMER:** Always audit before mainnet deployment.
