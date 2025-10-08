# Core Module Documentation

## Purpose

The `@otc-broker/core` module serves as the foundational layer of the OTC Broker Engine, providing essential type definitions, business invariants, decimal mathematics, and asset metadata management. This module ensures type safety, mathematical precision, and business rule enforcement across the entire OTC trading system.

## Architecture Overview

The module is organized into six main components that work together to provide a robust foundation for OTC trades:

```
packages/core/
├── src/
│   ├── types.ts         # Core type definitions for the entire system
│   ├── invariants.ts    # Business rule validation and state transitions
│   ├── decimal.ts       # Precise decimal mathematics for financial operations
│   ├── assets.ts        # Asset metadata and chain configurations
│   ├── assetConfig.ts   # Asset registry and configuration management
│   ├── nameGenerator.ts # Human-readable deal name generation
│   └── config/
│       └── assets.json  # Static asset and chain configurations
```

## Key Components

### 1. Type System (`types.ts`)

**Purpose**: Defines the complete type system for the OTC trading platform, ensuring type safety and consistency across all modules.

**Core Types**:
- **ChainId**: Identifies blockchain networks (UNICITY, ETH, POLYGON, SOLANA, BTC, custom chains)
- **AssetCode**: Identifies assets uniquely across chains (native tokens, ERC20, SPL tokens)
- **DealStage**: Tracks deal lifecycle states (CREATED → COLLECTION → WAITING → SWAP → CLOSED/REVERTED)
- **Deal**: The central data structure containing all deal information
- **QueueItem**: Represents pending blockchain transactions
- **EscrowDeposit**: Tracks confirmed deposits to escrow addresses

**Key Interfaces**:
- `DealAssetSpec`: Defines what each party wants to trade (chain, asset, amount)
- `PartyDetails`: Contains party addresses and optional email for notifications
- `CommissionRequirement`: Defines commission structure and calculation method
- `EscrowAccountRef`: References HD-derived escrow addresses
- `DealSideState`: Tracks deposits and locks for each party

### 2. Business Invariants (`invariants.ts`)

**Purpose**: Enforces business rules and validates state transitions to maintain system integrity.

**Core Functions**:
- `validateDealTransition()`: Ensures only valid state transitions occur
- `computeEligibleDeposits()`: Filters deposits based on confirmations and timing
- `checkLocks()`: Determines if sufficient funds are locked for trade execution
- `calculateSurplus()`: Computes refundable amounts after trade and commission
- `validateDealInvariants()`: Comprehensive validation of deal consistency

**Critical Invariants**:
1. **State Machine**: Deals follow strict state transitions
   - CREATED → COLLECTION (when both parties fill details)
   - COLLECTION → WAITING (when locks detected)
   - WAITING → SWAP (distribution in progress)
   - SWAP → CLOSED (successful completion)
   - Any state → REVERTED (timeout or failure)

2. **Lock Requirements**:
   - Deposits must have minimum confirmations (chain-specific)
   - Block time must be ≤ deal expiration time
   - Trade amount must be fully covered
   - Commission must be covered from surplus (never deducted from trade)

3. **Commission Policy**:
   - ALWAYS paid from surplus, NEVER from trade amount
   - Two modes: PERCENT_BPS (0.3% for known assets) or FIXED_USD_NATIVE ($10 for unknown tokens)
   - Freezes at COUNTDOWN start to avoid price volatility

### 3. Decimal Mathematics (`decimal.ts`)

**Purpose**: Provides precise decimal arithmetic for all financial calculations, avoiding JavaScript floating-point errors.

**Configuration**:
- Precision: 40 significant digits
- Rounding: ALWAYS rounds down for commissions (user-favorable)
- Exponential notation: Supports very large and small numbers

**Core Functions**:
- `parseAmount()`: Converts string amounts to Decimal objects
- `formatAmount()`: Formats decimals with specific precision
- `floorAmount()`: Floors to specific decimal places (for commission)
- `calculateCommission()`: Computes commission with basis points
- `sumAmounts()`: Adds multiple amounts precisely
- `compareAmounts()`: Compares amounts safely
- `subtractAmounts()`: Calculates differences (for surplus)

**Why Decimal.js?**:
- JavaScript numbers lose precision with large values
- Critical for blockchain amounts (18 decimals for ETH)
- Ensures deterministic calculations across all operations
- Prevents rounding errors in financial calculations

### 4. Asset Metadata (`assets.ts`)

**Purpose**: Manages runtime asset metadata including decimals, minimum amounts, and chain associations.

**Core Functions**:
- `getAssetMetadata()`: Returns metadata for any asset
- `getNativeAsset()`: Identifies native token for each chain
- `isAboveMinSendable()`: Validates minimum transaction amounts
- `getConfirmationThreshold()`: Returns chain-specific confirmation requirements

**Metadata Structure**:
```typescript
interface AssetMetadata {
  symbol: string;        // Display symbol (ETH, MATIC, ALPHA)
  decimals: number;      // Decimal places (8 for BTC, 18 for ETH)
  minSendable: string;   // Minimum viable amount
  isNative: boolean;     // Native chain token?
  chainId: ChainId;      // Associated blockchain
}
```

**Chain-Specific Configurations**:
- UNICITY: 6 confirmations, 8 decimals for ALPHA
- Ethereum: 3 confirmations, 18 decimals for ETH
- Polygon: 64 confirmations, 18 decimals for MATIC
- Solana: 10 confirmations, 9 decimals for SOL
- Bitcoin: 2 confirmations, 8 decimals for BTC

### 5. Asset Configuration (`assetConfig.ts`)

**Purpose**: Manages the static asset registry loaded from JSON configuration, providing a comprehensive database of supported assets.

**Core Functions**:
- `getAssetRegistry()`: Returns complete asset database
- `getAssetsByChain()`: Filters assets by blockchain
- `getAsset()`: Finds asset by chain and symbol
- `getAssetByContract()`: Finds ERC20/SPL tokens by address
- `formatAssetCode()`: Generates canonical asset codes
- `parseAssetCode()`: Parses asset codes to configurations
- `getAssetUrl()`: Generates blockchain explorer URLs

**Asset Types Supported**:
- NATIVE: Native blockchain tokens (ETH, MATIC, SOL, ALPHA)
- ERC20: Ethereum-based tokens (USDT, USDC, custom tokens)
- SPL: Solana Program Library tokens
- ERC721/ERC1155: NFTs (future support)

**Configuration Schema**:
```typescript
interface AssetConfig {
  assetName: string;       // Full name ("Ethereum")
  assetSymbol: string;     // Ticker ("ETH")
  chainId: string;         // Blockchain identifier
  native: boolean;         // Is native token?
  type: string;            // Token standard
  contractAddress?: string; // Smart contract address
  decimals: number;        // Decimal precision
  icon: string;            // Unicode/emoji icon
}
```

### 6. Name Generator (`nameGenerator.ts`)

**Purpose**: Creates human-readable, memorable names for deals to improve user experience.

**Features**:
- Combines adjectives and nouns for memorable names
- Adds timestamp for uniqueness and sorting
- Format: "Swift Eagle 2024-01-15 14:30"
- Validates names for security (prevents injection attacks)

**Name Components**:
- 32 adjectives (swift, bright, calm, etc.)
- 32 nouns (eagle, falcon, star, ocean, etc.)
- ISO date (YYYY-MM-DD)
- Time (HH:MM)

## Critical Implementation Rules

### 1. Amount Handling
- **NEVER** use JavaScript numbers for amounts
- **ALWAYS** use decimal.js for all calculations
- **ALWAYS** store amounts as strings in data structures
- **ALWAYS** validate decimal places match asset configuration

### 2. Commission Calculation
- **NEVER** deduct commission from trade amounts
- **ALWAYS** calculate commission from surplus
- **ALWAYS** floor commission calculations (user-favorable)
- **FREEZE** commission at COUNTDOWN start

### 3. Deposit Validation
- **REQUIRE** minimum confirmations per chain
- **VERIFY** block time ≤ expiration time
- **TRACK** explicit deposits (never trust balance queries)
- **DEDUPLICATE** by dealId/txid/index

### 4. State Transitions
- **VALIDATE** all transitions through `validateDealTransition()`
- **ATOMIC** database updates for state changes
- **IDEMPOTENT** operations at all boundaries
- **LEASE-BASED** processing for parallelism

## Asset Registry Structure

The `assets.json` configuration file contains:

### Supported Chains
1. **UNICITY**: Unicity PoW blockchain (mandatory)
2. **ETH**: Ethereum mainnet
3. **POLYGON**: Polygon/Matic network
4. **BASE**: Base L2 network
5. **SOLANA**: Solana blockchain

### Supported Assets (165 total)
- **Native Tokens**: ALPHA, ETH, MATIC, SOL
- **Stablecoins**: USDT, USDC, EURC (multi-chain)
- **Other**: DAI on Base
- **Custom**: ERC20 and SPL tokens via contract address

## Usage Examples

### Creating a Deal
```typescript
import { Deal, DealAssetSpec } from '@otc-broker/core';

const aliceSpec: DealAssetSpec = {
  chainId: 'ETH',
  asset: 'ETH',
  amount: '1.5'  // Always use strings
};

const bobSpec: DealAssetSpec = {
  chainId: 'UNICITY',
  asset: 'ALPHA@UNICITY',
  amount: '1000'
};
```

### Calculating Commission
```typescript
import { calculateCommission } from '@otc-broker/core';

const tradeAmount = '1000.50';
const commissionBps = 30; // 0.3%
const assetDecimals = 6;

const commission = calculateCommission(tradeAmount, commissionBps, assetDecimals);
// Result: "3.001500" (floored to 6 decimals)
```

### Validating Locks
```typescript
import { checkLocks } from '@otc-broker/core';

const lockStatus = checkLocks(
  deposits,
  'ETH',
  '1.5',
  'ETH',
  '0.0045',  // 0.3% commission
  12,        // min confirmations
  '2024-01-15T20:00:00Z'
);

if (lockStatus.tradeLocked && lockStatus.commissionLocked) {
  // Ready to execute swap
}
```

## Testing Considerations

### Unit Tests Should Cover
1. Decimal precision with edge cases (very large/small numbers)
2. State transition validation matrix
3. Commission calculation with different modes
4. Lock detection with various deposit scenarios
5. Asset metadata lookups and defaults
6. Name generation uniqueness

### Integration Tests Should Cover
1. Full deal lifecycle from CREATED to CLOSED
2. Timeout scenarios with partial funding
3. Reorg handling (confirmations dropping)
4. Multi-asset commission scenarios
5. Surplus calculation and refunds

## Security Considerations

1. **Input Validation**: All external inputs must be validated
2. **Decimal Precision**: Never truncate, always floor for user benefit
3. **State Machine**: Enforce invariants at every transition
4. **Name Validation**: Prevent injection in deal names
5. **Amount Strings**: Validate format before parsing

## Module Dependencies

- **decimal.js**: Arbitrary precision decimal arithmetic
- **TypeScript**: Type safety and compile-time checks
- **Node.js**: Runtime environment (18+)

## Future Enhancements

1. **Dynamic Asset Discovery**: Fetch token metadata from blockchain
2. **Multi-signature Support**: Complex escrow schemes
3. **Batch Operations**: Multiple deals in single transaction
4. **Cross-chain Oracle**: Decentralized price feeds
5. **NFT Support**: ERC721/ERC1155 trading