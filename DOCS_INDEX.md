# Documentation Index

## 🎯 Start Here

**For AI Agents**: Read documents in this order:
1. [`ARCHITECTURE.md`](./ARCHITECTURE.md) - System architecture overview
2. [`CLAUDE.md`](./CLAUDE.md) - Development guidelines and commands
3. [`DOCUMENTATION_SUMMARY.md`](./DOCUMENTATION_SUMMARY.md) - Navigation guide
4. Module-specific `MODULE.md` based on your task

## 📚 Main Documentation

### System-Level Documentation

| Document | Purpose | Size |
|----------|---------|------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Complete system architecture, components, data flows, security | 27KB |
| [CLAUDE.md](./CLAUDE.md) | Development commands, critical rules, project overview | 8KB |
| [DOCUMENTATION_SUMMARY.md](./DOCUMENTATION_SUMMARY.md) | Navigation guide and quick reference | 12KB |
| [README.md](./README.md) | Quick start and project overview | 4KB |

### Module Documentation

| Module | Location | Description |
|--------|----------|-------------|
| Core | [packages/core/MODULE.md](./packages/core/MODULE.md) | Types, decimal math, invariants, assets |
| Chains | [packages/chains/MODULE.md](./packages/chains/MODULE.md) | Blockchain plugin abstraction |
| Backend | [packages/backend/MODULE.md](./packages/backend/MODULE.md) | Engine, API, database, Tank Manager |
| Web | [packages/web/MODULE.md](./packages/web/MODULE.md) | User interface pages |
| Tools | [packages/tools/MODULE.md](./packages/tools/MODULE.md) | Utilities and scripts |

## 🔍 Documentation by Topic

### Architecture & Design
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Complete system design
- [OTC_BROKER_BIGDOC_v1.0.md](./OTC_BROKER_BIGDOC_v1.0.md) - Original specification

### Development
- [CLAUDE.md](./CLAUDE.md) - Development commands and standards
- [QUICK_START.md](./QUICK_START.md) - Quick setup guide
- [packages/*/MODULE.md](./packages/) - Module-specific guides

### Operations
- [KEY_EXPORT_GUIDE.md](./KEY_EXPORT_GUIDE.md) - Wallet key management
- [otc_gas_management_integration_tasks_ethereum_polygon.md](./otc_gas_management_integration_tasks_ethereum_polygon.md) - Gas management tasks

## 🎓 Learning Paths

### Path 1: Understanding the System
1. Read [ARCHITECTURE.md](./ARCHITECTURE.md) - Sections 1-6
2. Review deal lifecycle state machine
3. Understand multi-chain support model
4. Study security mechanisms

### Path 2: Adding Blockchain Support
1. Read [packages/chains/MODULE.md](./packages/chains/MODULE.md)
2. Study `ChainPlugin` interface in source
3. Review existing implementations (Unicity, EVM)
4. Follow implementation guide

### Path 3: Modifying Engine Logic
1. Read [packages/backend/MODULE.md](./packages/backend/MODULE.md)
2. Study `Engine.ts` JSDoc comments
3. Understand stage transitions
4. Review queue processing mechanics

### Path 4: Working with Business Rules
1. Read [packages/core/MODULE.md](./packages/core/MODULE.md)
2. Study `invariants.ts` functions
3. Understand commission policies
4. Review decimal math requirements

## 📖 Source Code Documentation

All source files contain comprehensive JSDoc comments:

### Core Package
- `types.ts` - Type definitions
- `invariants.ts` - Business rules
- `decimal.ts` - Math operations
- `assets.ts` - Asset metadata
- `assetConfig.ts` - Asset registry
- `nameGenerator.ts` - Name generation

### Chains Package
- `ChainPlugin.ts` - Plugin interface
- `UnicityPlugin.ts` - UTXO implementation
- `EthereumPlugin.ts` - EVM implementation
- `PolygonPlugin.ts` - Polygon specifics
- `utils/*` - Helper utilities

### Backend Package
- `Engine.ts` - Core processing engine ⭐
- `TankManager.ts` - Gas funding system ⭐
- `rpc-server.ts` - API server
- `database.ts` - Data layer
- `repositories/*` - CRUD operations

## 🔑 Key Concepts Reference

| Concept | Primary Documentation | Code Location |
|---------|---------------------|---------------|
| Deal Lifecycle | ARCHITECTURE.md § 6 | packages/backend/src/engine/Engine.ts |
| Stage Transitions | ARCHITECTURE.md § 6.2 | Engine.ts:processDeal() |
| Commission Model | ARCHITECTURE.md § 10 | packages/core/src/invariants.ts |
| Lock Verification | ARCHITECTURE.md § 9.4 | packages/core/src/invariants.ts:checkLocks() |
| Queue Processing | ARCHITECTURE.md § 13 | Engine.ts:processQueues*() |
| Tank Manager | ARCHITECTURE.md § 14 | packages/backend/src/engine/TankManager.ts |
| Chain Plugins | packages/chains/MODULE.md | packages/chains/src/*.ts |
| Deposit Tracking | ARCHITECTURE.md § 9.2 | packages/backend/src/db/repositories/DepositRepository.ts |

## 🛠️ Development Commands

```bash
# Setup
npm install
npm run build

# Development
npm run dev                    # Hot-reload development server
npm run db:migrate            # Run database migrations

# Testing
npm test                      # Run all tests
npm test -- <test-name>       # Run specific test

# Quality
npm run lint                  # Lint code
npm run typecheck            # Type checking
npm run clean                # Clean build artifacts
```

See [CLAUDE.md](./CLAUDE.md) for complete command reference.

## 🔐 Security Documentation

Critical security sections:
- ARCHITECTURE.md § 9 - Security and Safety Mechanisms
- Engine.ts - All `[CRITICAL]` comments
- invariants.ts - Lock verification logic

## 📊 Quick Stats

- **Documentation Files**: 7 main docs + 5 MODULE.md files
- **Total Documentation**: ~75KB structured documentation
- **Source Files**: 30+ files with JSDoc comments
- **Coverage**: 100% of public APIs documented
- **Code Comments**: Every function has purpose, params, returns

## 🚀 Getting Started Checklist

- [ ] Read [ARCHITECTURE.md](./ARCHITECTURE.md)
- [ ] Read [CLAUDE.md](./CLAUDE.md)
- [ ] Review relevant [MODULE.md](./packages/) files
- [ ] Scan JSDoc comments in source files
- [ ] Review `.env.example` for configuration
- [ ] Run `npm install && npm run build`

---

**Last Updated**: 2025-10-08
**Documentation Version**: 1.0
