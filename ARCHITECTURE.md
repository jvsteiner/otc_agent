# OTC Broker Engine - System Architecture

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Problem Statement](#problem-statement)
3. [High-Level Architecture](#high-level-architecture)
4. [Core Concepts](#core-concepts)
5. [System Components](#system-components)
6. [Deal Lifecycle and State Machine](#deal-lifecycle-and-state-machine)
7. [Data Flow Architecture](#data-flow-architecture)
8. [Multi-Chain Support](#multi-chain-support)
9. [Security and Safety Mechanisms](#security-and-safety-mechanisms)
10. [Commission Model](#commission-model)
11. [Database Architecture](#database-architecture)
12. [API Architecture](#api-architecture)
13. [Queue Processing System](#queue-processing-system)
14. [Tank Manager (Gas Funding)](#tank-manager-gas-funding)
15. [Error Handling and Recovery](#error-handling-and-recovery)
16. [Implementation Considerations](#implementation-considerations)

## Executive Summary

The OTC Broker Engine is a trustless, multi-chain system for facilitating peer-to-peer asset swaps between two parties. It acts as an automated escrow agent that coordinates cross-chain trades without taking custody of funds. The system supports mandatory integration with Unicity (a UTXO-based blockchain) and optional support for EVM chains (Ethereum, Polygon), with extensibility for other chains like Solana and Bitcoin.

The engine operates on a deal-based model where two parties (Alice and Bob) agree to swap specific amounts of different assets across different blockchains. The system handles escrow generation, deposit monitoring, confirmation tracking, atomic swaps, commission collection, and automatic refunds in case of failures or timeouts.

## Problem Statement

### The Challenge

Traditional cryptocurrency trading faces several critical challenges:

1. **Trust Requirements**: Direct peer-to-peer trades require one party to send first, creating counterparty risk
2. **Cross-Chain Complexity**: Different blockchains have incompatible transaction models (UTXO vs account-based)
3. **Atomicity**: Ensuring both sides of a trade execute or neither executes
4. **Reorg Protection**: Blockchain reorganizations can reverse confirmed transactions
5. **Fee Management**: Different chains require different native currencies for transaction fees
6. **Commission Collection**: Broker needs compensation without affecting trade amounts

### The Solution

The OTC Broker Engine solves these challenges through:

- **Deterministic Escrow Addresses**: HD-derived addresses unique to each deal and party
- **Multi-Stage Deal Flow**: Progressive stages with atomic transitions and rollback capabilities
- **Explicit Deposit Tracking**: Never relies on balance queries alone, tracks individual deposits
- **Confirmation-Based Locks**: Waits for sufficient blockchain confirmations before executing swaps
- **Phased Queue Processing**: Ensures proper ordering for UTXO chains while parallelizing for account-based chains
- **Automatic Refunds**: Returns funds if deals timeout or fail
- **Commission from Surplus**: Never deducts from trade amounts, only takes surplus

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Web Interface                        │
│  - Deal Creation Page                                        │
│  - Alice Personal Page (/d/{dealId}/a/{token})              │
│  - Bob Personal Page (/d/{dealId}/b/{token})                │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────┴─────────────────────────────────┐
│                      JSON-RPC API Server                     │
│  - otc.createDeal                                           │
│  - otc.fillPartyDetails                                     │
│  - otc.status                                               │
│  - otc.sendInvite                                           │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────┴─────────────────────────────────┐
│                      Core Engine System                      │
│ ┌─────────────────┐  ┌─────────────────┐                   │
│ │  Deal Processor │  │ Queue Processor │                   │
│ │   (30s loop)    │  │   (5s loop)     │                   │
│ └────────┬────────┘  └────────┬────────┘                   │
│          │                     │                             │
│ ┌────────┴──────────────────────┴────────┐                 │
│ │         Deal State Manager              │                 │
│ │  - Stage Transitions                    │                 │
│ │  - Lock Verification                    │                 │
│ │  - Transfer Planning                    │                 │
│ └──────────────────┬──────────────────────┘                 │
└────────────────────┼────────────────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────────────────┐
│                    Chain Plugin Layer                        │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│ │   Unicity    │ │   Ethereum   │ │   Polygon    │        │
│ │   Plugin     │ │   Plugin     │ │   Plugin     │        │
│ │   (UTXO)     │ │   (Account)  │ │   (Account)  │        │
│ └──────────────┘ └──────────────┘ └──────────────┘        │
└─────────────────────────────────────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────────────────┐
│                     Data Access Layer                        │
│ ┌────────────────────────────────────────────────┐         │
│ │              SQLite Database (WAL mode)         │         │
│ │  - deals        - escrow_deposits               │         │
│ │  - queue_items  - accounts                      │         │
│ │  - leases       - events                        │         │
│ └────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Deal

A Deal represents a single swap agreement between two parties:

- **Alice**: First party (sender of asset A, receiver of asset B)
- **Bob**: Second party (sender of asset B, receiver of asset A)
- **Timeout**: Maximum time allowed for both parties to deposit funds
- **Escrows**: Deterministically generated addresses for receiving deposits

### Escrow System

The escrow system uses hierarchical deterministic (HD) key derivation:

1. **Master Seed**: Single HOT_WALLET_SEED environment variable
2. **Deal-Specific Keys**: Derived using deal ID as entropy
3. **Party Separation**: Different addresses for Alice's and Bob's deposits
4. **Chain-Specific**: Each chain gets its own escrow address

### Commission Model

Two commission modes ensure broker compensation:

1. **PERCENT_BPS** (Basis Points): 0.3% of trade amount for known assets
2. **FIXED_USD_NATIVE**: $10 equivalent in native currency for unknown tokens

Key principles:
- Commission comes from surplus deposits, never deducted from trade amounts
- Commission requirements freeze at COUNTDOWN start (COLLECTION stage)
- Both sides must satisfy commission requirements for locks

### Multi-Chain Transaction Models

The engine handles two fundamentally different blockchain models:

1. **UTXO-Based (Unicity, Bitcoin)**:
   - Transactions consume entire outputs
   - Multiple outputs per transaction possible
   - Requires careful UTXO selection
   - Phased processing to avoid conflicts

2. **Account-Based (Ethereum, Polygon)**:
   - Simple balance transfers
   - Sequential nonce management
   - Parallel processing possible across accounts

## System Components

### 1. Engine (Deal Processor)

**Location**: `packages/backend/src/engine/Engine.ts`

The main orchestrator that:
- Runs every 30 seconds
- Processes deals through their lifecycle
- Monitors deposits and confirmations
- Triggers stage transitions
- Handles reorg detection

Key methods:
- `processDeal()`: Main deal processing logic
- `updateDeposits()`: Queries chains for new deposits
- `checkLocks()`: Verifies sufficient confirmed deposits
- `buildTransferPlan()`: Creates queue items for distribution

### 2. Queue Processor

**Location**: `packages/backend/src/engine/Engine.ts`

Independent processor that:
- Runs every 5 seconds
- Submits pending transactions
- Monitors transaction confirmations
- Handles resubmissions on failure
- Processes in phases for UTXO chains

Processing phases:
1. **PHASE_1_SWAP**: Distribute trade amounts to recipients
2. **PHASE_2_COMMISSION**: Send commission to operator
3. **PHASE_3_REFUND**: Return surplus or timeout refunds

### 3. Chain Plugins

**Interface**: `packages/chains/src/ChainPlugin.ts`

Abstraction layer for blockchain interactions:

```typescript
interface ChainPlugin {
  // Account Management
  generateEscrowAccount(asset, dealId, party): Promise<EscrowAccountRef>

  // Deposit Monitoring
  listConfirmedDeposits(asset, address, minConf): Promise<EscrowDepositsView>

  // Transaction Submission
  send(asset, from, to, amount): Promise<SubmittedTx>

  // Fee Management
  ensureFeeBudget(from, asset, intent, minNative): Promise<void>

  // Monitoring
  getTxConfirmations(txid): Promise<number>
}
```

Implementations:
- **UnicityPlugin**: UTXO-based, uses Electrum protocol
- **EvmPlugin**: Base class for Ethereum-like chains
- **EthereumPlugin**: Ethereum mainnet specific
- **PolygonPlugin**: Polygon network specific

### 4. Data Access Layer (DAL)

**Location**: `packages/backend/src/db/repositories/`

Repository pattern for database operations:

- **DealRepository**: CRUD operations for deals
- **DepositRepository**: Track confirmed deposits
- **QueueRepository**: Manage transaction queue
- **PayoutRepository**: Track multi-asset payouts
- **LeaseRepository**: Distributed processing locks

### 5. Tank Manager

**Location**: `packages/backend/src/engine/TankManager.ts`

Optional gas funding system for EVM chains:
- Maintains tank wallet with native currency
- Automatically funds escrow addresses for gas
- Monitors and alerts on low balances
- Recovers gas after successful swaps

### 6. RPC Server

**Location**: `packages/backend/src/api/rpc-server.ts`

JSON-RPC API endpoints:
- `otc.createDeal`: Initialize new swap
- `otc.fillPartyDetails`: Set party addresses
- `otc.status`: Query deal status
- `otc.sendInvite`: Send email invitations
- `otc.cancelDeal`: Cancel pending deal

## Deal Lifecycle and State Machine

### State Transitions

```
CREATED → COLLECTION → WAITING → SWAP → CLOSED
            ↓            ↓         ↓
         REVERTED ← ─────┴─────────┘
            ↓
          CLOSED
```

### Stage Descriptions

#### 1. CREATED
- Initial state after deal creation
- Waiting for both parties to fill details
- No timer active
- Can only transition to COLLECTION

#### 2. COLLECTION
- Both parties have filled details
- Countdown timer starts (expiresAt set)
- Actively monitoring for deposits
- Transitions:
  - → WAITING: When sufficient funds detected
  - → REVERTED: On timeout

#### 3. WAITING
- Sufficient funds detected on both sides
- Timer SUSPENDED (not cleared)
- Waiting for confirmation threshold
- Transitions:
  - → SWAP: When locks confirmed
  - → COLLECTION: On reorg (funds lost)

#### 4. SWAP
- Both sides have confirmed locks
- Timer PERMANENTLY REMOVED
- Actively distributing funds
- Cannot timeout - must complete
- Transitions:
  - → CLOSED: All transactions confirmed
  - → COLLECTION: On critical reorg

#### 5. REVERTED
- Deal cancelled due to timeout or user request
- Processing refunds to original depositors
- Transitions:
  - → CLOSED: All refunds confirmed

#### 6. CLOSED
- Final state - deal completed or fully refunded
- Continues monitoring for late deposits
- Automatically refunds any post-close deposits

### Lock Verification

Locks ensure sufficient confirmed funds before swap:

```typescript
interface SideLocks {
  tradeLockedAt?: string      // Timestamp when trade amount confirmed
  commissionLockedAt?: string  // Timestamp when commission confirmed
}
```

Lock requirements:
- Deposits must have `confirms ≥ collectConfirms`
- Deposit `blockTime ≤ expiresAt`
- Total must cover trade amount + commission

## Data Flow Architecture

### 1. Deal Creation Flow

```
User → Web UI → RPC Server → DealRepository
                    ↓
              Generate Tokens
                    ↓
            Create Deal Record
                    ↓
            Return Personal Links
```

### 2. Party Registration Flow

```
Party → Personal Page → RPC Server → Validate Addresses
                            ↓
                     Update Deal Record
                            ↓
                     Generate Escrows
                            ↓
                   Plugin.generateEscrowAccount()
```

### 3. Deposit Collection Flow

```
Blockchain → Plugin.listConfirmedDeposits() → Engine.updateDeposits()
                                                      ↓
                                              DepositRepository.save()
                                                      ↓
                                              Update collectedByAsset
                                                      ↓
                                                Check Locks
```

### 4. Swap Execution Flow

```
Engine.checkLocks() → Both Sides Locked → buildTransferPlan()
                                                ↓
                                        QueueRepository.enqueue()
                                                ↓
                                         Queue Processor
                                                ↓
                                    Plugin.send() [Phase 1]
                                    Plugin.send() [Phase 2]
                                    Plugin.send() [Phase 3]
```

## Multi-Chain Support

### Chain Identification

Chains are identified by ChainId enum:
- `UNICITY`: Unicity blockchain (mandatory)
- `ETH`: Ethereum mainnet
- `POLYGON`: Polygon network
- `SOLANA`: Solana (future)
- `BTC`: Bitcoin (future)

### Asset Representation

Assets use composite identifiers:
- Native: `ETH`, `MATIC`, `ALPHA@UNICITY`
- ERC-20: `ERC20:0x...` (contract address)
- SPL: `SPL:...` (Solana tokens)

### Chain-Specific Handling

#### UTXO Chains (Unicity)
- Phased queue processing
- UTXO selection algorithms
- Multi-output transaction building
- Change address management

#### Account Chains (Ethereum, Polygon)
- Nonce management
- Gas estimation
- ERC-20 token support
- Tank funding for gas

## Security and Safety Mechanisms

### 1. Atomic State Transitions

All stage transitions occur within database transactions:

```typescript
db.transaction(() => {
  // Update stage
  dealRepo.updateStage(dealId, newStage)

  // Update related records
  queueRepo.enqueue(items)

  // Add audit event
  dealRepo.addEvent(dealId, message)
})
```

### 2. Reorg Protection

Multiple layers of reorg protection:

1. **Confirmation Thresholds**:
   - Wait for chain-specific confirmation counts
   - Unicity: 6 blocks
   - Ethereum: 12 blocks
   - Polygon: 64 blocks

2. **Explicit Deposit Tracking**:
   - Never rely on balance queries
   - Track individual deposits by txid
   - Detect disappeared transactions

3. **Stage Reversions**:
   - WAITING → COLLECTION on fund loss
   - Automatic refund triggering

### 3. Double-Spend Prevention

Queue system prevents double-spending:

```typescript
// Critical safeguard in QueueRepository
if (item.purpose === 'TIMEOUT_REFUND') {
  const existingSwaps = getSwapPayouts(dealId, from, asset)
  if (existingSwaps.pending > 0) {
    throw new Error('Cannot refund - pending swap exists')
  }
}
```

### 4. Lease-Based Processing

Prevents concurrent deal processing:

```typescript
interface Lease {
  dealId: string
  ownerId: string      // Engine instance ID
  leaseUntil: string   // ISO timestamp
}
```

Lease duration: ~90 seconds per deal

### 5. Commission Safety

Commission requirements frozen at COLLECTION:
- Protects against price volatility
- Ensures predictable costs
- Calculated from oracle prices

### 6. Timeout Protection

Deals have configurable timeouts:
- Set when entering COLLECTION
- Suspended during WAITING
- Removed permanently in SWAP
- Automatic reversion on expiry

## Commission Model

### Calculation Methods

#### PERCENT_BPS (Known Assets)
```typescript
commission = floor(tradeAmount * percentBps / 10000)
```
- Default: 30 basis points (0.3%)
- Applied to known assets (ETH, MATIC, ALPHA)
- Calculated in asset currency

#### FIXED_USD_NATIVE (Unknown Assets)
```typescript
nativeAmount = usdFixed / oraclePrice
commission = floor(nativeAmount)
```
- Default: $10 USD
- Applied to unknown ERC-20/SPL tokens
- Paid in chain's native currency

### Commission Collection

1. **Requirement Check**: Both sides must have surplus for commission
2. **Lock Verification**: Commission locks separate from trade locks
3. **Distribution Phase**: Phase 2 in queue processing
4. **Surplus Handling**: Excess returned to depositors

## Database Architecture

### Core Tables

#### deals
```sql
CREATE TABLE deals (
  dealId TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  json TEXT NOT NULL,        -- Full Deal object snapshot
  createdAt TEXT NOT NULL,
  expiresAt TEXT
)
```

#### escrow_deposits
```sql
CREATE TABLE escrow_deposits (
  dealId TEXT NOT NULL,
  chainId TEXT NOT NULL,
  address TEXT NOT NULL,
  asset TEXT NOT NULL,
  txid TEXT NOT NULL,
  idx INTEGER,
  amount TEXT NOT NULL,
  blockHeight INTEGER,
  blockTime TEXT,
  confirms INTEGER NOT NULL,
  UNIQUE (dealId, txid, idx)
)
```

#### queue_items
```sql
CREATE TABLE queue_items (
  id TEXT PRIMARY KEY,
  dealId TEXT NOT NULL,
  chainId TEXT NOT NULL,
  fromAddr TEXT NOT NULL,
  toAddr TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  purpose TEXT NOT NULL,
  phase TEXT,              -- For UTXO chains
  seq INTEGER NOT NULL,    -- Sequence per sender
  status TEXT NOT NULL,
  submittedTx TEXT         -- JSON TxRef
)
```

### Database Configuration

SQLite with WAL mode for concurrency:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

## API Architecture

### JSON-RPC Interface

All API calls follow JSON-RPC 2.0 specification:

```json
{
  "jsonrpc": "2.0",
  "method": "otc.createDeal",
  "params": {
    "alice": {
      "chainId": "ETH",
      "asset": "ETH",
      "amount": "1.5"
    },
    "bob": {
      "chainId": "UNICITY",
      "asset": "ALPHA@UNICITY",
      "amount": "1000"
    },
    "timeoutSeconds": 3600
  },
  "id": 1
}
```

### Web Interface

Three main pages:

1. **Deal Creation** (`/`):
   - Form for specifying swap parameters
   - Generates personal links for parties

2. **Alice's Page** (`/d/{dealId}/a/{token}`):
   - Shows escrow addresses
   - Displays deal status
   - Tracks deposits

3. **Bob's Page** (`/d/{dealId}/b/{token}`):
   - Mirror of Alice's page for Bob
   - Separate authentication token

## Queue Processing System

### Queue Purpose Types

```typescript
type QueuePurpose =
  | 'SWAP_PAYOUT'      // Trade amount to recipient
  | 'OP_COMMISSION'    // Commission to operator
  | 'SURPLUS_REFUND'   // Return excess deposits
  | 'TIMEOUT_REFUND'   // Return on timeout/failure
  | 'GAS_REFUND_TO_TANK' // Return gas to tank
```

### Processing Strategy

#### Account-Based Chains
- Process items sequentially per account
- Manage nonce incrementation
- Allow parallel processing across accounts

#### UTXO-Based Chains
- Three-phase processing
- Build multi-output transactions
- Handle change addresses
- Prevent UTXO conflicts

### Transaction Monitoring

```typescript
interface TxRef {
  txid: string
  chainId: ChainId
  submittedAt: string
  confirms: number
  requiredConfirms: number
  status: 'PENDING' | 'CONFIRMED' | 'DROPPED'
}
```

Monitoring cycle:
1. Submit transaction
2. Poll for confirmations
3. Handle reorgs (resubmit if dropped)
4. Mark complete when confirmed

## Tank Manager (Gas Funding)

### Purpose

Solves the "gas problem" for EVM escrow addresses:
- Escrow addresses need native currency for gas
- Tank wallet pre-funds escrows
- Recovers gas after successful swaps

### Configuration

```bash
TANK_WALLET_PRIVATE_KEY=0x...
ETH_GAS_FUND_AMOUNT=0.01
POLYGON_GAS_FUND_AMOUNT=0.5
ETH_LOW_GAS_THRESHOLD=0.1
POLYGON_LOW_GAS_THRESHOLD=5
```

### Operation Flow

1. **Detection**: Check if escrow needs gas
2. **Funding**: Send native currency from tank
3. **Execution**: Escrow can now send tokens
4. **Recovery**: Queue GAS_REFUND_TO_TANK
5. **Monitoring**: Alert on low tank balance

## Error Handling and Recovery

### Failure Modes and Recovery

#### 1. Partial Deposits
- **Issue**: One party deposits, other doesn't
- **Recovery**: Timeout triggers automatic refund

#### 2. Blockchain Reorg
- **Issue**: Confirmed deposits disappear
- **Recovery**: Revert to COLLECTION, resume timer

#### 3. Transaction Failure
- **Issue**: Submitted transaction fails
- **Recovery**: Resubmit with adjusted parameters

#### 4. Engine Crash
- **Issue**: Engine stops mid-processing
- **Recovery**: Lease expires, next engine takes over

#### 5. Late Deposits
- **Issue**: Deposits arrive after deal closes
- **Recovery**: Continuous monitoring and auto-refund

### Audit Trail

All significant events logged to database:

```typescript
interface Event {
  dealId: string
  timestamp: string
  message: string
}
```

Examples:
- "Both parties ready, entering collection phase"
- "Funds detected on side A: 1.5 ETH"
- "Confirmations complete, executing swap"
- "REORG: Funds lost, reverting to COLLECTION"

## Implementation Considerations

### Performance Optimizations

1. **Database Indexes**:
   - deals(stage) for active deal queries
   - escrow_deposits(dealId, address) for deposit lookups
   - queue_items(status, fromAddr) for queue processing

2. **Caching**:
   - Oracle price quotes (15-minute TTL)
   - Chain plugin connections
   - Wallet derivation paths

3. **Batch Processing**:
   - Multiple deposits per query
   - Multi-output transactions for UTXO
   - Parallel queue processing where possible

### Scalability Considerations

1. **Horizontal Scaling**:
   - Multiple engine instances
   - Lease-based coordination
   - Shared database (SQLite limitations)

2. **Chain Limitations**:
   - Electrum connection limits
   - RPC rate limiting
   - Block time variations

3. **Database Migration Path**:
   - SQLite suitable for <1000 deals/day
   - PostgreSQL for higher volumes
   - Repository pattern enables easy migration

### Testing Strategy

Critical test scenarios:

1. **Happy Path**: Complete swap with commission
2. **Timeout**: Single-side funding timeout
3. **Reorg Before Lock**: Funds disappear before confirmation
4. **Reorg After Lock**: Funds disappear after swap starts
5. **Crash Recovery**: Engine restart mid-swap
6. **Unknown Tokens**: ERC-20 with USD commission
7. **Gas Management**: Tank funding and recovery
8. **Late Deposits**: Funds after deal closes
9. **Dust Handling**: Minimum amounts and rounding

### Security Checklist

- [ ] All state transitions atomic
- [ ] Deposits explicitly tracked
- [ ] Confirmation thresholds enforced
- [ ] Double-spend prevention active
- [ ] Reorg detection functional
- [ ] Commission calculations correct
- [ ] Refund mechanisms tested
- [ ] Private keys properly derived
- [ ] Database properly secured
- [ ] API authentication implemented

## Conclusion

The OTC Broker Engine represents a sophisticated solution to the cross-chain swap problem, balancing security, reliability, and user experience. Its multi-layered architecture ensures atomic swaps while protecting against common blockchain pitfalls like reorgs and double-spends.

The system's strength lies in its explicit state management, comprehensive error handling, and chain-agnostic plugin architecture. By treating each deal as an isolated state machine with well-defined transitions, the engine provides predictable and recoverable execution even in the face of failures.

Future enhancements could include support for additional chains (Solana, Bitcoin), advanced order matching, liquidity pools, and decentralized governance. The modular architecture ensures these features can be added without disrupting the core engine logic.

For AI agents working with this codebase, focus on understanding the state machine, queue processing phases, and lock verification logic as these form the critical path of deal execution. The commission model and reorg protection mechanisms are also essential for maintaining system integrity and economic viability.