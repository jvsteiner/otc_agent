# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Generic OTC (Over-The-Counter) Broker Engine for swapping assets between two parties across different blockchain chains, with at least one side being Unicity PoW.

## Technology Stack

- **Language**: TypeScript with Node.js
- **Database**: better-sqlite3 with WAL mode enabled
- **Architecture**: Monorepo with packages structure
- **Required chains**: Unicity (mandatory), EVM chains (ETH/Polygon), optionally Solana and BTC

## Core Architecture

### Package Structure
- `packages/core`: Core types, invariants, state helpers, decimal math via decimal.js
- `packages/chains`: ChainPlugin interface and adapters (Unicity, EVM, Solana, BTC)
- `packages/backend`: JSON-RPC server, engine loop (30s), notifier, DAL
- `packages/web`: Static/SSR minimal pages for deal creation and personal pages
- `packages/tools`: Scripts, simulators, seeding utilities

## Development Commands

### Build & Setup
```bash
# Install dependencies (after package.json is created)
npm install

# Run TypeScript build
npm run build

# Run development server
npm run dev

# Run tests
npm test

# Run specific test
npm test -- <test-name>

# Lint code
npm run lint

# Type check
npm run typecheck
```

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
- Two commission modes: PERCENT_BPS (for known assets) and FIXED_USD_NATIVE (for unknown ERC-20/SPL)
- Trade amounts are sacrosanct - exact specified amounts must be swapped

### Threat Mitigations (MUST IMPLEMENT)
1. Use per-deal leases for parallel processing
2. Lock only on confirmed deposits (collectConfirms ≥ finality+margin)
3. Lock based on blockTime ≤ expiresAt
4. Two-phase distribution: Preflight → Plan → Broadcast
5. Atomic DB transactions for stage transitions
6. Serial submission per account with nonce/UTXO management
7. Compute locks from explicit deposits, not raw balances
8. Reserve native for commission AND gas
9. Use floor for commission calculations
10. Post-close watcher for late deposits (7 days)

### Engine Loop
- Runs every 30 seconds
- Per-deal lease duration: ~90 seconds
- Process stages: CREATED → COLLECTION → WAITING → CLOSED (or REVERTED)
- All stage transitions happen in DB transactions

### Implementation Packets Order
When implementing from scratch, follow this order:
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

## Environment Configuration

Key environment variables:
- `DB_PATH`: SQLite database path
- `PORT`: Server port
- Chain-specific: `<CHAIN>_RPC`, `<CHAIN>_CONFIRMATIONS`, `<CHAIN>_OPERATOR_ADDRESS`

## Important Constraints

- NEVER use JavaScript floats for amounts - use decimal.js exclusively
- Maintain idempotency at every boundary (plan, submit, notify)
- Unicity Plugin is MANDATORY in v1
- All deposits must be explicitly tracked - never rely on balance queries alone
- Commission freezes at COUNTDOWN start to avoid price volatility