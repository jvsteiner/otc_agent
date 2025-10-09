# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Generic OTC (Over-The-Counter) Broker Engine for swapping assets between two parties across different blockchain chains, with at least one side being Unicity PoW.

## Technology Stack

- **Language**: TypeScript with Node.js 18+
- **Database**: better-sqlite3 with WAL mode enabled
- **Architecture**: Monorepo with packages structure using npm workspaces
- **Required chains**: Unicity (mandatory), EVM chains (ETH/Polygon)
- **Optional chains**: Solana, Bitcoin

## Development Commands

### Setup & Build
```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run development server (hot-reload)
npm run dev

# Run database migrations
npm run db:migrate
```

### Testing & Quality
```bash
# Run all tests
npm test

# Run specific test file
npm test packages/core/test/specific-test.test.ts

# Run tests in watch mode
npm test -- --watch

# Lint code
npm run lint

# Type check
npm run typecheck

# Clean build artifacts
npm run clean
```

## Core Architecture

### Package Structure
- `packages/core`: Core types, invariants, state helpers, decimal math via decimal.js
- `packages/chains`: ChainPlugin interface and adapters (Unicity, EVM, Solana, BTC)
- `packages/backend`: JSON-RPC server, engine loop (30s), notifier, DAL
- `packages/web`: Static/SSR minimal pages for deal creation and personal pages
- `packages/tools`: Scripts, simulators, seeding utilities

### Database Schema
SQLite database with key tables:
- `deals`: Deal state and JSON snapshots
- `escrow_deposits`: Confirmed deposits tracking (deduped by dealId/txid/idx)
- `queue_items`: Transaction broadcast queue
- `accounts`: Nonce/UTXO state tracking
- `wallets`: HD wallet index persistence

### Database Setup
Always initialize SQLite with these pragmas:
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

## Critical Implementation Rules

### Commission Policy (AUTHORITATIVE)
- Commission is ONLY paid from surplus, NEVER deducted from trade amount
- Two commission modes: PERCENT_BPS (0.3% for known assets) and FIXED_USD_NATIVE ($10 for unknown ERC-20/SPL)
- Trade amounts are sacrosanct - exact specified amounts must be swapped
- Commission freezes at COUNTDOWN start to avoid price volatility

### Deal Flow Stages
```
CREATED → COLLECTION → WAITING → SWAP → CLOSED (or REVERTED)
```
- CREATED: Deal initialized, waiting for party details
- COLLECTION: Both parties filled, countdown active, awaiting deposits
- WAITING: Funds received, waiting for confirmations (timer suspended)
- SWAP: Confirmations complete, executing transfers (timer removed permanently)
- CLOSED: Successfully completed
- REVERTED: Timeout or failure, refunds issued

**Critical Stage Transition Rules:**
- COLLECTION → WAITING: When both sides have sufficient funds (timer suspends)
- WAITING → COLLECTION: If reorg detected, revert with timer resumed
- WAITING → SWAP: When both sides have confirmed locks (timer removed forever)
- SWAP → CLOSED: When all queue items are confirmed
- Any stage → REVERTED: On timeout (except SWAP which cannot timeout)

### Threat Mitigations (MUST IMPLEMENT)
1. Use per-deal leases for parallel processing (~90 seconds)
2. Lock only on confirmed deposits (collectConfirms ≥ finality+margin)
3. Lock based on blockTime ≤ expiresAt
4. Three-phase queue distribution: SWAP → COMMISSION → REFUND
5. Atomic DB transactions for stage transitions
6. Serial submission per account with nonce/UTXO management
7. Compute locks from explicit deposits, not raw balances
8. Reserve native for commission AND gas
9. Use floor for commission calculations
10. Post-close watcher for late deposits (7 days)
11. Reorg detection: Revert WAITING → COLLECTION if funds drop
12. Timer management: Suspend in WAITING, remove permanently in SWAP

### Engine Loop
- **Deal Processor**: Runs every 30 seconds with ~90s per-deal leases
- **Queue Processor**: Independent loop (also 30s) handles transaction broadcasting
- Process stages sequentially with atomic transitions
- All stage transitions happen in DB transactions
- Handles parallel processing via lease mechanism
- Queue processing has three sequential phases:
  - PHASE_1_SWAP: Payout transfers to Alice and Bob
  - PHASE_2_COMMISSION: Commission to operator
  - PHASE_3_REFUND: Surplus/timeout refunds
  - Gas refunds (GAS_REFUND_TO_TANK) processed after all other queue items

### Tank Manager (Gas Funding System)
- Optional EVM gas funding mechanism for escrow addresses
- Automatically funds escrow addresses with native currency for gas
- Monitors low balances and refunds tank after successful swaps
- Configure via `TANK_WALLET_PRIVATE_KEY` environment variable
- Per-chain fund amounts and low thresholds configurable
- Escrow addresses queue `GAS_REFUND_TO_TANK` items after swap completion

## API Endpoints

### JSON-RPC Server (POST /rpc)
- `otc.createDeal`: Initialize new deal (optional custom name via `name` param)
- `otc.fillPartyDetails`: Set party addresses and email
- `otc.status`: Get deal status
- `otc.listDeals`: List deals with filters
- `otc.sendInvite`: Send invitation email to party
- `otc.setPrice`: Manually set oracle price for testing (dev only)

### Web Interface
- `/`: Deal creation page
- `/d/{dealId}/a/{token}`: Alice's personal page
- `/d/{dealId}/b/{token}`: Bob's personal page

## Environment Configuration

Required environment variables (.env file):
```bash
# Server
PORT=8080
DB_PATH=./data/otc.db
BASE_URL=http://localhost:8080
LOG_LEVEL=info

# Hot Wallet Seed (for generating escrow addresses)
HOT_WALLET_SEED=<secure-seed-phrase>

# Tank Wallet Configuration (optional, for gas funding)
TANK_WALLET_PRIVATE_KEY=0x<private-key>
ETH_GAS_FUND_AMOUNT=0.01        # ETH to send for gas funding
POLYGON_GAS_FUND_AMOUNT=0.5     # MATIC to send for gas funding
ETH_LOW_GAS_THRESHOLD=0.1       # Alert when tank ETH balance is below this
POLYGON_LOW_GAS_THRESHOLD=5     # Alert when tank MATIC balance is below this

# Unicity (MANDATORY)
UNICITY_ELECTRUM=wss://electrum.unicity.io:50002
UNICITY_CONFIRMATIONS=6
UNICITY_COLLECT_CONFIRMS=6
UNICITY_OPERATOR_ADDRESS=<your-unicity-address>

# Ethereum Configuration (optional)
ETH_RPC=http://localhost:8545
ETH_CONFIRMATIONS=3
ETH_COLLECT_CONFIRMS=3
ETH_OPERATOR_ADDRESS=0x<operator-address>

# Polygon Configuration (optional)
POLYGON_RPC=https://polygon-rpc.com
POLYGON_CONFIRMATIONS=64
POLYGON_COLLECT_CONFIRMS=64
POLYGON_OPERATOR_ADDRESS=0x<operator-address>

# Email Configuration (optional)
EMAIL_ENABLED=false
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER=<your-email>
EMAIL_SMTP_PASS=<your-app-password>
```

## ChainPlugin Interface

All chain adapters must implement:
- `init()`: Initialize plugin
- `generateEscrowAddress()`: Create deterministic HD addresses
- `getEscrowBalance()`: Query balances
- `getConfirmedDeposits()`: Track explicit deposits
- `submitTransaction()`: Broadcast transactions
- `estimateTransactionCost()`: Gas estimation
- `getOracleQuote()`: USD pricing for commissions

## Implementation Packets Order

When implementing from scratch:
1. Scaffold & DB runtime (monorepo, SQLite setup)
2. Core types & invariants
3. Chain plugin interface & Unicity adapter
4. DAL & Migrations
5. JSON-RPC & HTTP pages
6. Engine v3 (locks+plan+queues)
7. EVM plugin (ETH/Polygon)
8. Solana plugin (optional)
9. Notifications
10. Simulators & E2E tests

## Testing Requirements

E2E test scenarios that MUST pass:
1. Happy swap with commission payment
2. Timeout with single-side funding
3. Near-boundary deposits
4. Reorg before/after lock
5. Crash recovery
6. Unknown ERC-20 dual deposits
7. Gas budget management
8. Late deposit refunds
9. Rounding & dust handling

## Important Constraints

- NEVER use JavaScript floats for amounts - use decimal.js exclusively
- Maintain idempotency at every boundary (plan, submit, notify)
- Unicity Plugin is MANDATORY in v1
- All deposits must be explicitly tracked - never rely on balance queries alone
- Use atomic database transactions for all state changes
- Handle reorgs via confirmation thresholds per chain
- Escrow addresses are HD-derived (BIP32/44) from HOT_WALLET_SEED
- All transaction queue items must be persisted to `queue_items` table before submission
- Gas refunds must complete before marking deal as fully closed

## Debugging & Development Tools

### Inspecting Deal State
```bash
# Query deal details from database
sqlite3 ./data/otc.db "SELECT * FROM deals WHERE id='<deal-id>';"

# Check queue items for a deal
sqlite3 ./data/otc.db "SELECT * FROM queue_items WHERE dealId='<deal-id>';"

# View escrow deposits
sqlite3 ./data/otc.db "SELECT * FROM escrow_deposits WHERE dealId='<deal-id>';"
```

### Common Issues
- **Stuck transactions**: Check queue_items table for PENDING items without submittedTx
- **Missing confirmations**: Verify chain RPC endpoints are accessible
- **Reorg handling**: Check if collectConfirms threshold is sufficient for chain
- **Gas refund failures**: Verify tank wallet has sufficient native currency balance