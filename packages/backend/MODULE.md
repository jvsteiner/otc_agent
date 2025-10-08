# Backend Module Documentation

## Overview

The Backend module is the core server component of the OTC Broker Engine, responsible for orchestrating over-the-counter trades between two parties across different blockchain chains. It provides a JSON-RPC API server, automated deal processing engine, database management, and transaction queue processing.

## Purpose

This module serves as the central coordinator for:
- **Deal Lifecycle Management**: Processing deals through stages from creation to completion
- **Cross-chain Transaction Orchestration**: Managing atomic swaps across different blockchains
- **Safety and Security**: Implementing critical safeguards against double-spending and reorgs
- **Database Persistence**: Maintaining deal state, transaction history, and audit trails
- **API Services**: Exposing JSON-RPC endpoints for deal creation and monitoring

## Architecture

### Core Components

#### 1. **Engine (`src/engine/Engine.ts`)**
The heart of the system that runs on a 30-second interval to process deals through their lifecycle.

**Key Responsibilities:**
- Stage transition management (CREATED → COLLECTION → WAITING → SWAP/CLOSED)
- Deposit monitoring and confirmation tracking
- Lock verification using confirmed deposits
- Transfer plan building and execution
- Reorg detection and recovery
- Post-close escrow monitoring

**Critical Features:**
- Two-phase locking: Both sides must be funded before proceeding
- Timer suspension in WAITING stage
- Independent queue processor (5-second interval)
- Phased transaction processing for UTXO chains
- Automatic refund mechanisms for timeouts and surplus

#### 2. **RPC Server (`src/api/rpc-server.ts`)**
JSON-RPC 2.0 compliant API server providing deal management endpoints.

**Endpoints:**
- `otc.createDeal`: Initialize new OTC deal with asset specifications
- `otc.fillPartyDetails`: Set party addresses and contact information
- `otc.status`: Query deal status and progress
- `otc.sendInvite`: Send email invitations to counterparties
- `otc.cancelDeal`: Cancel deal (with proper authorization)
- `otc.getChainConfig`: Get supported chain configurations

**Web Interface Support:**
- Static pages for deal creation
- Personal pages for Alice and Bob with unique tokens
- Real-time status updates

#### 3. **Data Access Layer (DAL)**
Repository pattern implementation for database operations.

##### **DealRepository** (`src/db/repositories/DealRepository.ts`)
- CRUD operations for deals
- Stage transitions with atomic updates
- Event logging for audit trails
- Party details management

##### **QueueRepository** (`src/db/repositories/QueueRepository.ts`)
- Transaction queue management
- Phase-based processing for UTXO chains
- Status tracking (PENDING → SUBMITTED → COMPLETED)
- Critical safeguards against double-spending

##### **DepositRepository** (`src/db/repositories/DepositRepository.ts`)
- Tracks confirmed deposits by txid/index
- Deduplication to prevent double-counting
- Confirmation count tracking

##### **PayoutRepository** (`src/db/repositories/PayoutRepository.ts`)
- Manages payout plans for UTXO chains
- Links queue items to payouts
- Tracks minimum confirmations across multiple transactions

#### 4. **Tank Manager (`src/engine/TankManager.ts`)**
Gas funding system for EVM chains to ensure escrows can execute transactions.

**Features:**
- Automatic gas estimation for ERC20 and native transfers
- Escrow funding when gas is insufficient
- Balance monitoring and alerts
- Refund gas to tank after deal completion

## Database Schema

### Core Tables

#### **deals**
- Primary deal storage with JSON snapshots
- Tracks stage, timing, and expiration
- Indexed by stage for efficient queries

#### **escrow_deposits**
- Confirmed deposits only (deduped by dealId/txid/idx)
- Tracks amount, confirmations, block time
- Critical for lock determination

#### **queue_items**
- Transaction broadcast queue
- Supports phased processing (PHASE_1_SWAP, PHASE_2_COMMISSION, PHASE_3_REFUND)
- Status tracking with transaction references
- Sequential processing per sender

#### **accounts**
- Nonce management for account-based chains
- UTXO state tracking for Bitcoin-like chains
- Prevents transaction conflicts

#### **party_details**
- Stores party addresses and contact info
- Links escrow accounts to deals
- Tracks lock status

#### **gas_funding**
- Records gas funding transactions from tank
- Tracks which escrows received gas
- Used for proper refund routing

## Engine Loop Mechanics

### Main Processing Loop (30-second interval)

1. **Monitor Submitted Transactions**
   - Check confirmation counts
   - Detect reorgs (transactions disappearing)
   - Update queue item statuses

2. **Process Active Deals**
   - Stage-specific processing
   - Atomic state transitions
   - Event logging

### Stage Processing Details

#### **CREATED Stage**
- Monitor deposits (show progress)
- Transition to COLLECTION when both parties filled
- No timeout enforcement

#### **COLLECTION Stage**
- Active deposit monitoring
- Timeout enforcement
- Transition to WAITING when both sides funded
- Timer suspension on WAITING entry

#### **WAITING Stage**
- Wait for confirmation thresholds
- Detect reorgs (funds dropping)
- Build transfer plan on confirmation
- Transition to SWAP stage
- Timer permanently removed on SWAP entry

#### **SWAP Stage**
- Execute transfer queues
- Process in phases for UTXO chains
- Monitor transaction confirmations
- Transition to CLOSED when all complete

#### **REVERTED Stage**
- Process refund queues
- Return all deposits to payback addresses
- Monitor refund confirmations

#### **CLOSED Stage**
- Monitor for late deposits
- Auto-return any remaining funds
- Process post-close surplus refunds

### Queue Processing Mechanics

#### Independent Queue Processor (5-second interval)
Runs separately from main engine loop to ensure timely transaction submission.

**For Account-based Chains (ETH, Polygon):**
- Process all pending items in parallel
- Manage nonces sequentially per account
- Submit transactions immediately

**For UTXO Chains (Unicity):**
- Phase-based sequential processing
- Phase 1: Swap payouts (must complete first)
- Phase 2: Commission payments
- Phase 3: Surplus refunds
- Each phase must complete before next begins

### Critical Safeguards

1. **Double-Spend Prevention**
   - Never revert if both sides locked
   - Block refunds if swap payouts pending
   - Block swaps if refunds exist

2. **Reorg Protection**
   - Detect funds dropping below requirements
   - Revert to COLLECTION on fund loss
   - Resubmit disappeared transactions

3. **Atomic State Transitions**
   - All stage changes in database transactions
   - Consistent state even on crashes

4. **Timer Management**
   - Suspended in WAITING (can resume on reorg)
   - Permanently removed in SWAP (must complete)
   - Enforced only in COLLECTION

5. **Phased Processing for UTXO**
   - Prevents UTXO conflicts
   - Ensures correct transaction ordering
   - Handles multi-output transactions

## Transaction Flow

### Successful Swap Flow
```
1. Deal Created (CREATED)
   ↓
2. Both parties fill details
   ↓
3. Enter COLLECTION (timer starts)
   ↓
4. Both sides deposit funds
   ↓
5. Enter WAITING (timer suspended)
   ↓
6. Confirmations reached
   ↓
7. Enter SWAP (timer removed)
   ↓
8. Execute transfers:
   - Alice's asset → Bob
   - Bob's asset → Alice
   - Commissions → Operator
   - Surplus → Payback addresses
   ↓
9. All confirmed → CLOSED
```

### Timeout/Revert Flow
```
1. COLLECTION stage
   ↓
2. Timer expires
   ↓
3. Check locks (must not both be locked)
   ↓
4. Enter REVERTED
   ↓
5. Queue refunds to payback addresses
   ↓
6. Process refund transactions
   ↓
7. All confirmed → CLOSED
```

### Reorg Recovery Flow
```
1. WAITING stage (funds confirmed)
   ↓
2. Reorg detected (funds drop)
   ↓
3. Revert to COLLECTION
   ↓
4. Resume timer
   ↓
5. Wait for deposits again
   ↓
6. Re-enter WAITING when funded
```

## Configuration

### Environment Variables

**Required:**
- `DB_PATH`: SQLite database file path
- `HOT_WALLET_SEED`: HD wallet seed for escrow generation
- `PORT`: Server port (default: 8080)
- `BASE_URL`: Public URL for links

**Chain Configuration:**
- `UNICITY_ELECTRUM`: Unicity Electrum server URL
- `ETH_RPC`: Ethereum RPC endpoint
- `POLYGON_RPC`: Polygon RPC endpoint
- `*_CONFIRMATIONS`: Required confirmations per chain
- `*_OPERATOR_ADDRESS`: Commission recipient per chain

**Tank Manager (Optional):**
- `TANK_WALLET_PRIVATE_KEY`: Tank wallet for gas funding
- `*_GAS_FUND_AMOUNT`: Amount to fund per chain
- `*_LOW_GAS_THRESHOLD`: Alert threshold

## Security Considerations

1. **Escrow Key Management**
   - HD-derived keys from HOT_WALLET_SEED
   - Deterministic but unique per deal
   - Never reuse addresses across deals

2. **Transaction Authorization**
   - Only escrow can send funds
   - Strict destination validation
   - Amount verification before sending

3. **Database Integrity**
   - WAL mode for consistency
   - Atomic transactions for state changes
   - Foreign key constraints

4. **API Security**
   - Token-based party authorization
   - Rate limiting recommended
   - Input validation on all endpoints

## Monitoring & Operations

### Key Metrics to Monitor
- Deal stage distribution
- Queue processing latency
- Transaction confirmation times
- Tank balance levels
- Reorg frequency

### Common Issues & Resolution

**Stuck in WAITING:**
- Check confirmation thresholds
- Verify chain connectivity
- Look for reorgs

**Queue Processing Delays:**
- Check nonce conflicts
- Verify gas/fee sufficiency
- Monitor chain congestion

**Tank Balance Low:**
- Refill tank wallet
- Check for gas leaks
- Review funding amounts

## Development & Testing

### Local Setup
```bash
# Install dependencies
npm install

# Run migrations
npm run db:migrate

# Start development server
npm run dev
```

### Testing Scenarios
1. Happy path swap
2. Timeout with single-side funding
3. Reorg during WAITING
4. Gas funding for ERC20
5. Phased UTXO processing
6. Post-close surplus refunds

## Future Enhancements

### Planned Improvements
1. Multi-signature escrow support
2. Batch transaction processing
3. Advanced fee optimization
4. Cross-chain atomic swaps
5. WebSocket event streaming
6. Enhanced monitoring dashboard

### Scalability Considerations
- Database sharding for high volume
- Queue worker separation
- Read replica support
- Caching layer for chain queries