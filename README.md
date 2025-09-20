# OTC Broker Engine

A generic Over-The-Counter (OTC) broker engine for swapping assets between two parties across different blockchain chains. At least one side must be Unicity PoW.

## Features

- **Multi-chain support**: Unicity (mandatory), Ethereum, Polygon, Solana (optional), Bitcoin (optional)
- **Escrow management**: Automatic generation and management of escrow addresses
- **Commission handling**: Two modes - percentage-based (PERCENT_BPS) or fixed USD in native currency (FIXED_USD_NATIVE)
- **Robust engine**: 30-second processing loop with per-deal leases for parallel processing
- **Safety features**: Confirmation thresholds, reorg protection, timeout handling, atomic database transactions

## Architecture

This is a TypeScript monorepo with the following packages:

- **packages/core**: Core types, decimal math, asset metadata, invariants
- **packages/chains**: Chain plugin interface and implementations (Unicity, EVM)
- **packages/backend**: Database layer, JSON-RPC API, engine loop
- **packages/web**: Static HTML pages for deal creation and management
- **packages/tools**: Utilities and scripts (future)

## Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- SQLite3

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/otc-broker.git
cd otc-broker
```

2. Install dependencies:
```bash
npm install
```

3. Copy the environment configuration:
```bash
cp .env.example .env
```

4. Edit `.env` with your configuration:
   - Set `UNICITY_OPERATOR_ADDRESS` to your Unicity address for receiving commissions
   - Configure other chains as needed
   - Set a secure `HOT_WALLET_SEED`

5. Run database migrations:
```bash
npm run db:migrate
```

## Running the Engine

### Development Mode

```bash
npm run dev
```

This starts the engine with hot-reloading enabled.

### Production Mode

```bash
npm run build
node packages/backend/dist/index.js
```

## API Endpoints

### JSON-RPC API (POST /rpc)

#### Create Deal
```json
{
  "jsonrpc": "2.0",
  "method": "otc.createDeal",
  "params": {
    "alice": {
      "chainId": "UNICITY",
      "asset": "ALPHA@UNICITY",
      "amount": "100.0"
    },
    "bob": {
      "chainId": "ETH",
      "asset": "ETH",
      "amount": "0.05"
    },
    "timeoutSeconds": 3600
  },
  "id": 1
}
```

#### Fill Party Details
```json
{
  "jsonrpc": "2.0",
  "method": "otc.fillPartyDetails",
  "params": {
    "dealId": "deal_id_here",
    "party": "ALICE",
    "paybackAddress": "UNI123...",
    "recipientAddress": "0x456...",
    "email": "alice@example.com",
    "token": "token_here"
  },
  "id": 2
}
```

#### Get Status
```json
{
  "jsonrpc": "2.0",
  "method": "otc.status",
  "params": {
    "dealId": "deal_id_here"
  },
  "id": 3
}
```

### Web Interface

- **Deal Creation**: http://localhost:8080/
- **Alice Personal Page**: http://localhost:8080/d/{dealId}/a/{token}
- **Bob Personal Page**: http://localhost:8080/d/{dealId}/b/{token}

## Deal Flow

1. **Creation**: Creator defines what Alice sells and what Bob sells
2. **Personal Links**: System generates unique links for Alice and Bob
3. **Details Collection**: Each party enters their payback and recipient addresses
4. **Countdown**: When both parties have filled details, timeout countdown begins
5. **Collection**: Parties send funds to their escrow addresses
6. **Lock Detection**: Engine monitors for trade and commission locks
7. **Distribution**: Once both sides are locked, engine distributes funds
8. **Completion**: Deal closes when all transfers are confirmed

## Commission Policy

- **Known Assets**: 0.3% (30 basis points) paid in the same asset
- **Unknown ERC-20/SPL Tokens**: $10 USD equivalent paid in native currency (ETH/MATIC/SOL)
- Commission is paid from surplus only - trade amounts are never reduced

## Safety Features

- **Confirmation thresholds**: Configurable per chain (e.g., 6 for Unicity, 3 for ETH, 64 for Polygon)
- **Reorg protection**: Deposits only count after sufficient confirmations
- **Timeout handling**: Automatic refunds if deal expires
- **Lease management**: Prevents duplicate processing in multi-instance deployments
- **Atomic operations**: All critical state changes happen in database transactions

## Development

### Running Tests
```bash
npm test
```

### Linting
```bash
npm run lint
```

### Type Checking
```bash
npm run typecheck
```

## License

ISC

## Support

For issues and feature requests, please open an issue on GitHub.