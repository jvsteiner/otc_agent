# OTC Broker Engine - Documentation Summary

## Overview

This document provides a roadmap to all architectural and code documentation created for the OTC Broker Engine. The documentation is structured to help AI agents and developers quickly understand the system architecture before diving into specific code modules.

## Documentation Structure

### 📘 Entry Point: Architectural Documentation

**File**: `/ARCHITECTURE.md` (27KB, ~600 lines)

Start here to understand the entire system. This comprehensive document covers:

- **Executive Summary** - What the system does and why
- **Problem Statement** - Cross-chain trading challenges and solutions
- **High-Level Architecture** - System components and their interactions
- **Core Concepts** - Deal lifecycle, escrow system, commission model
- **System Components** - Detailed breakdown of Engine, Queue Processor, Chain Plugins, DAL, Tank Manager, RPC Server
- **Deal Lifecycle** - Complete state machine (CREATED → COLLECTION → WAITING → SWAP → CLOSED/REVERTED)
- **Data Flow Architecture** - Step-by-step transaction flows
- **Multi-Chain Support** - How different blockchain types are handled
- **Security & Safety** - Comprehensive threat mitigations
- **Commission Model** - PERCENT_BPS vs FIXED_USD_NATIVE
- **Database Architecture** - Schema and tables
- **API Architecture** - JSON-RPC endpoints and web interface
- **Queue Processing** - Phased processing for UTXO chains
- **Tank Manager** - Gas funding system for EVM chains
- **Error Handling & Recovery** - Failure modes and recovery strategies

### 📚 Module-Level Documentation

Each package has a `MODULE.md` file providing module-specific architectural details:

#### 1. **Core Module** (`/packages/core/MODULE.md`)
- **Purpose**: Foundation types, decimal math, invariants, asset metadata
- **Key Files**:
  - `types.ts` - Core type definitions with full JSDoc
  - `invariants.ts` - Business rule validation functions
  - `decimal.ts` - Precise financial mathematics
  - `assets.ts` - Runtime asset metadata management
  - `assetConfig.ts` - Static asset registry
  - `nameGenerator.ts` - Deal name generation
- **Critical Rules**: Never use JavaScript floats, always use decimal.js

#### 2. **Chains Module** (`/packages/chains/MODULE.md`)
- **Purpose**: ChainPlugin abstraction for blockchain integration
- **Key Implementations**:
  - `UnicityPlugin.ts` - UTXO-based chain with Electrum protocol
  - `EthereumPlugin.ts` - EVM mainnet with HD wallets
  - `PolygonPlugin.ts` - Polygon PoS with higher confirmations
  - `BasePlugin.ts` - Coinbase L2 optimistic rollup
- **Plugin Pattern**: Uniform interface for different blockchain types
- **Key Methods**: All plugins implement init(), generateEscrowAddress(), getConfirmedDeposits(), send()

#### 3. **Backend Module** (`/packages/backend/MODULE.md`)
- **Purpose**: Core server component - engine, RPC API, database
- **Key Components**:
  - `Engine.ts` - Main processing loop (30s interval) with full JSDoc
  - `TankManager.ts` - Gas funding system for EVM chains
  - `rpc-server.ts` - JSON-RPC API server
  - `database.ts` - SQLite wrapper with WAL mode
  - Repositories: DealRepository, QueueRepository, DepositRepository, PayoutRepository
- **Database Tables**: deals, escrow_deposits, queue_items, accounts, wallets, gas_funding, tank_balances
- **Critical Logic**: Stage transitions, lock verification, queue processing, reorg detection

#### 4. **Web Module** (`/packages/web/MODULE.md`)
- **Purpose**: User-facing HTML interfaces for deal management
- **Key Pages**:
  - `/` - Deal creation page
  - `/d/{dealId}/a/{token}` - Alice's personal page
  - `/d/{dealId}/b/{token}` - Bob's personal page
- **Current Implementation**: Server-rendered HTML in RPC server
- **Future**: Can evolve into standalone static/SSR application

#### 5. **Tools Module** (`/packages/tools/MODULE.md`)
- **Purpose**: Scripts, utilities, wallet management tools
- **Key Tools**:
  - `export-keys.ts` - Exports Unicity HD wallet keys (JSON/Wallet/WIF formats)
  - `export-html-wallet.ts` - Creates standalone HTML wallets
- **Use Cases**: Key backup, wallet recovery, testing, debugging

## Quick Navigation Guide

### For AI Agents Starting Fresh

1. **First**: Read `ARCHITECTURE.md` to understand the complete system
2. **Second**: Read `CLAUDE.md` for development commands and critical rules
3. **Third**: Navigate to the specific module's `MODULE.md` based on your task:
   - Working on types/business logic? → `packages/core/MODULE.md`
   - Adding blockchain support? → `packages/chains/MODULE.md`
   - Modifying engine/API? → `packages/backend/MODULE.md`
   - Updating UI? → `packages/web/MODULE.md`
   - Creating tools? → `packages/tools/MODULE.md`
4. **Fourth**: Read the JSDoc comments in the specific source files

### For Specific Tasks

| Task | Documentation Path |
|------|-------------------|
| Understanding deal lifecycle | `ARCHITECTURE.md` → "Deal Lifecycle and State Machine" |
| Adding new blockchain | `packages/chains/MODULE.md` → "Implementation Guide" |
| Modifying commission logic | `packages/core/MODULE.md` → "invariants.ts" + `ARCHITECTURE.md` → "Commission Model" |
| Understanding engine loop | `packages/backend/MODULE.md` → "Engine Loop Mechanics" |
| Database schema changes | `packages/backend/MODULE.md` → "Database Schema" |
| API endpoint modifications | `packages/backend/MODULE.md` → "RPC Server" + `ARCHITECTURE.md` → "API Architecture" |
| Queue processing logic | `ARCHITECTURE.md` → "Queue Processing System" |
| Gas funding system | `ARCHITECTURE.md` → "Tank Manager" + `packages/backend/MODULE.md` → "Tank Manager" |

## JSDoc Comment Coverage

All source files now include comprehensive JSDoc comments:

### Core Package
✅ `types.ts` - Every type and interface documented
✅ `invariants.ts` - All functions with parameters, returns, examples
✅ `decimal.ts` - Mathematical functions with precision notes
✅ `assets.ts` - Chain configurations and metadata
✅ `assetConfig.ts` - Registry management functions
✅ `nameGenerator.ts` - Name generation algorithms

### Chains Package
✅ `ChainPlugin.ts` - Interface methods documented
✅ `PluginManager.ts` - Factory pattern documentation
✅ `UnicityPlugin.ts` - UTXO-specific implementation
✅ `EvmPlugin.ts` - Base EVM implementation
✅ `EthereumPlugin.ts` - Ethereum-specific features
✅ `PolygonPlugin.ts` - Polygon-specific configuration
✅ `BasePlugin.ts` - Coinbase L2 implementation
✅ All utility files in `utils/` directory

### Backend Package
✅ `Engine.ts` - Complete class and method documentation
✅ `TankManager.ts` - Gas funding system documentation
✅ `rpc-server.ts` - API endpoints and web routes
✅ `database.ts` - Database wrapper methods
✅ All repository files with CRUD operations
✅ `email.ts` - Email service documentation

### Tools Package
✅ `export-keys.ts` - Key export utility functions
✅ `export-html-wallet.ts` - HTML wallet generator

## Critical Sections for AI Agents

### Security-Critical Code
- `packages/backend/src/engine/Engine.ts` - Lines with `[CRITICAL]` comments
- `packages/core/src/invariants.ts` - `checkLocks()` function
- All stage transition logic in `Engine.ts`

### Business Logic
- `packages/core/src/invariants.ts` - All lock and commission calculations
- `packages/backend/src/engine/Engine.ts` - `buildTransferPlan()` method
- Commission policy documented in `ARCHITECTURE.md` and `CLAUDE.md`

### State Management
- `packages/backend/src/engine/Engine.ts` - `processDeal()` method
- Stage transitions: CREATED → COLLECTION → WAITING → SWAP → CLOSED
- Timer management: Suspend in WAITING, remove in SWAP

### Multi-Chain Handling
- `packages/chains/src/` - All plugin implementations
- `packages/backend/src/engine/Engine.ts` - `processQueuesPhased()` vs `processQueuesNormal()`

## Documentation Maintenance

### When to Update Documentation

1. **ARCHITECTURE.md** - When adding major components or changing system flow
2. **MODULE.md** - When adding new files or significantly changing module purpose
3. **JSDoc Comments** - Every time you modify a function signature or behavior
4. **CLAUDE.md** - When adding new development commands or critical rules

### Documentation Standards

- **File-level**: `@fileoverview` describing file purpose
- **Function-level**: `@param`, `@returns`, `@throws` with examples
- **Type/Interface**: Description of purpose and usage
- **Critical sections**: Add `[CRITICAL]` comments for security-sensitive code
- **Examples**: Include usage examples for complex functions

## Additional Resources

- `README.md` - Quick start guide and project overview
- `QUICK_START.md` - Fast setup instructions
- `KEY_EXPORT_GUIDE.md` - Wallet key management guide
- `.env.example` - Environment variable reference
- `OTC_BROKER_BIGDOC_v1.0.md` - Original comprehensive specification

## Summary Statistics

- **Total Documentation Files Created**: 6 (1 ARCHITECTURE.md + 5 MODULE.md files)
- **Total Documentation Size**: ~70KB of structured documentation
- **Source Files with JSDoc**: 30+ files across all packages
- **Coverage**: 100% of public APIs and critical functions
- **Average Module Doc Size**: ~10-13KB per module

## Conclusion

This documentation structure ensures that:

1. **AI agents** can quickly understand the system architecture before making changes
2. **New developers** have a clear learning path from high-level to low-level
3. **Code changes** are guided by documented architectural principles
4. **Security-critical** sections are clearly marked and explained
5. **Business rules** are documented alongside implementation

Start with `ARCHITECTURE.md`, then drill down into specific modules as needed. All critical functions have inline JSDoc comments explaining their behavior and constraints.
