# OTC Broker - Quick Start Guide

## ✅ Server is Running!

Your OTC Broker server is now running at: **http://localhost:8080**

## 🚀 How to Use

### 1. Access the Web Interface
Open your browser and go to: **http://localhost:8080**

### 2. Create a Deal
- Fill in what Alice sells (e.g., 100 ALPHA@UNICITY)
- Fill in what Bob sells (e.g., 0.05 ETH)
- Set timeout (default: 3600 seconds = 1 hour)
- Click "Create Deal"
- You'll get two personal links - one for Alice, one for Bob

### 3. Complete the Deal
- Alice opens her link and enters:
  - Payback address (Unicity address for refunds)
  - Recipient address (ETH address to receive Bob's asset)
- Bob does the same with his link
- Once both fill details, countdown starts
- Both parties send funds to their escrow addresses
- Engine automatically swaps when both sides are funded

## 📡 API Access

### Check Server Status
```bash
curl http://localhost:8080/
```

### Create Deal via API
```bash
curl -X POST http://localhost:8080/rpc \
  -H "Content-Type: application/json" \
  -d '{
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
  }'
```

## 🔑 Export Escrow Keys

To export the wallet keys for your escrow addresses:

```bash
cd packages/tools

# Export as HTML wallet (easiest)
npx tsx src/export-html-wallet.ts -o my-escrow-wallet.html

# Export as text
npx tsx src/export-keys.ts -f wallet -o keys.txt
```

## 🛠️ Configuration

The server is using these settings (.env):
- **Port**: 8080
- **Database**: ./data/otc.db
- **Unicity Electrum**: wss://fulcrum.unicity.network:50004
- **Confirmations**: 6 blocks for Unicity
- **Hot Wallet Seed**: otc-broker-dev-seed-unicity-2024

⚠️ **Important**: Update `UNICITY_OPERATOR_ADDRESS` in .env to receive commissions!

## 📊 Monitor Server

The server logs show:
- Engine running every 30 seconds
- RPC server on port 8080
- Deal processing status
- Transaction broadcasts

## 🛑 Stop Server

Press `Ctrl+C` in the terminal where the server is running.

## 🔄 Restart Server

```bash
npx tsx packages/backend/src/index.ts
```

Or in development mode with auto-reload:
```bash
npm run dev
```

## 📝 Database

View deals in the database:
```bash
sqlite3 data/otc.db "SELECT * FROM deals;"
```

## 🆘 Troubleshooting

### Port already in use
Change the port in .env file:
```
PORT=8081
```

### Electrum connection issues
The server automatically reconnects. Check your internet connection.

### Build errors
Run with tsx directly (bypasses TypeScript compilation):
```bash
npx tsx packages/backend/src/index.ts
```

---

**Server Status**: ✅ RUNNING on http://localhost:8080