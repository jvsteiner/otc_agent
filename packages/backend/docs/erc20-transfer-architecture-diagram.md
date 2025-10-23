# ERC20 Transfer Parsing Architecture Diagram

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Blockchain (Ethereum/Polygon)                       │
│                                                                              │
│  ┌──────────────────────┐         ┌────────────────────────────────────┐   │
│  │ UnicitySwapBroker    │         │ ERC20 Token Contract (USDT/USDC)  │   │
│  │                      │         │                                    │   │
│  │ swapERC20()         │────────▶│ Transfer(from, to, value)         │   │
│  │ revertERC20()       │         │ Transfer(from, to, value)         │   │
│  │ refundERC20()       │         │ Transfer(from, to, value)         │   │
│  └──────────────────────┘         └────────────────────────────────────┘   │
│           │                                     │                            │
│           │                                     │                            │
│           │ Transaction Hash                    │ Event Logs                │
└───────────┼─────────────────────────────────────┼────────────────────────────┘
            │                                     │
            │                                     │
            ▼                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Data Sources Layer                                   │
│                                                                              │
│  ┌────────────────────────┐          ┌────────────────────────────────┐    │
│  │  Etherscan API         │          │  RPC Node (eth_getReceipt)     │    │
│  │                        │          │                                │    │
│  │  GET /api              │          │  {                             │    │
│  │    ?module=logs        │          │    "logs": [{                  │    │
│  │    &action=getLogs     │          │      "address": "0xToken...",  │    │
│  │    &address=<TOKEN>    │          │      "topics": [...],          │    │
│  │    &topic0=0xddf...    │          │      "data": "0x..."           │    │
│  │    &txhash=<HASH>      │          │    }]                          │    │
│  │                        │          │  }                             │    │
│  └────────────────────────┘          └────────────────────────────────┘    │
│           │                                     │                            │
│           │ Primary                             │ Fallback                   │
└───────────┼─────────────────────────────────────┼────────────────────────────┘
            │                                     │
            │                                     │
            ▼                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      EthereumPlugin (Chain Adapter)                          │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  getERC20Transfers(txHash, tokenAddress): Promise<Transfer[]>     │    │
│  │                                                                    │    │
│  │  1. Try Etherscan API (if API key available)                      │    │
│  │     └─▶ EtherscanAPI.getERC20TransfersByTxHash()                 │    │
│  │                                                                    │    │
│  │  2. Fallback to RPC (if Etherscan fails)                          │    │
│  │     └─▶ provider.getTransactionReceipt()                         │    │
│  │     └─▶ Filter logs by token address and Transfer topic          │    │
│  │                                                                    │    │
│  │  3. Decode and format transfers                                   │    │
│  │     └─▶ Extract from/to/value from log topics and data           │    │
│  │     └─▶ Format amounts using token decimals                       │    │
│  │                                                                    │    │
│  │  4. Classify transfers                                             │    │
│  │     └─▶ Filter: only transfers FROM escrow                        │    │
│  │     └─▶ Sort: by log index (execution order)                      │    │
│  │     └─▶ Classify: swap/fee/refund based on position               │    │
│  │                                                                    │    │
│  │  Returns: [                                                        │    │
│  │    { from, to, value: "100.5", type: "swap", logIndex: 5 },       │    │
│  │    { from, to, value: "3.0", type: "fee", logIndex: 6 },          │    │
│  │    { from, to, value: "97.0", type: "refund", logIndex: 7 }       │    │
│  │  ]                                                                 │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────┬───────────────────────────────┘
                                              │
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Engine (Deal Processor)                            │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  After BROKER_SWAP/BROKER_REVERT confirms:                         │    │
│  │                                                                    │    │
│  │  1. Extract token address from queueItem.asset                     │    │
│  │  2. Call plugin.getERC20Transfers(txHash, tokenAddress)           │    │
│  │  3. Store transfers in queueItem.erc20Transfers                    │    │
│  │  4. Log transfers in deal.events for audit trail                   │    │
│  │  5. Update deal status to show transfer breakdown                  │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────┬───────────────────────────────┘
                                              │
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          API Layer (JSON-RPC Server)                         │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  otc.status Response:                                              │    │
│  │  {                                                                 │    │
│  │    "dealId": "...",                                                │    │
│  │    "stage": "SWAP",                                                │    │
│  │    "outQueue": [                                                   │    │
│  │      {                                                             │    │
│  │        "purpose": "BROKER_SWAP",                                   │    │
│  │        "submittedTx": { "txid": "0xabc..." },                      │    │
│  │        "erc20Transfers": [                                         │    │
│  │          { "to": "0xbob...", "value": "1000.0", "type": "swap" }, │    │
│  │          { "to": "0xop...", "value": "3.0", "type": "fee" },      │    │
│  │          { "to": "0xalice...", "value": "97.0", "type": "refund" }│    │
│  │        ]                                                           │    │
│  │      }                                                             │    │
│  │    ]                                                               │    │
│  │  }                                                                 │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow Sequence

```
User/Frontend
      │
      │ otc.status
      │
      ▼
┌─────────────────┐
│  RPC Server     │
│  (GET status)   │
└────────┬────────┘
         │
         │ Read deal + queue items
         │
         ▼
┌─────────────────┐
│  Database       │
│  (deals table)  │
└────────┬────────┘
         │
         │ Queue items with txHash
         │
         ▼
┌─────────────────┐         ┌──────────────────┐
│  Engine         │────────▶│ EthereumPlugin   │
│  (if needed)    │         │                  │
└─────────────────┘         └────────┬─────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
                    ▼                                 ▼
         ┌──────────────────┐            ┌──────────────────┐
         │ EtherscanAPI     │            │ RPC Provider     │
         │ getLogs          │            │ getReceipt       │
         └──────────┬───────┘            └────────┬─────────┘
                    │                             │
                    │ ERC20 Transfer Logs         │
                    │                             │
                    └────────────┬────────────────┘
                                 │
                                 ▼
                    ┌──────────────────────┐
                    │ Parse & Classify     │
                    │ - Filter by escrow   │
                    │ - Sort by logIndex   │
                    │ - Classify by pattern│
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Return to Engine     │
                    │ Store in queue item  │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Persist to Database  │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Return to API        │
                    └──────────┬───────────┘
                               │
                               ▼
                            User sees
                            transfer breakdown
```

## Transfer Classification Decision Tree

```
                        ERC20 Transfer Logs
                               │
                               ▼
                   ┌───────────────────────┐
                   │ Filter: FROM = escrow │
                   │ (ignore incoming)     │
                   └───────────┬───────────┘
                               │
                               ▼
                   ┌───────────────────────┐
                   │ Sort by logIndex      │
                   │ (execution order)     │
                   └───────────┬───────────┘
                               │
                               ▼
                   ┌───────────────────────┐
                   │ Count transfers       │
                   └───────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │ 1 Transfer   │  │ 2 Transfers  │  │ 3+ Transfers │
     └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
            │                 │                  │
            ▼                 ▼                  ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │ Index 0      │  │ Index 0      │  │ Index 0      │
     │ Type: refund │  │ Type: fee    │  │ Type: swap   │
     └──────────────┘  └──────┬───────┘  └──────┬───────┘
                              │                  │
                              ▼                  ▼
                       ┌──────────────┐  ┌──────────────┐
                       │ Index 1      │  │ Index 1      │
                       │ Type: refund │  │ Type: fee    │
                       └──────────────┘  └──────┬───────┘
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │ Index 2+     │
                                         │ Type: refund │
                                         └──────────────┘
```

## Broker Contract Operation Patterns

### swapERC20 (Success Case)

```
Transaction: 0xabc123...
Status: SUCCESS (receipt.status = 1)

ERC20 Transfer Events (sorted by logIndex):
┌────────┬──────────────┬────────────────┬────────────┬──────────┐
│ Index  │ From         │ To             │ Value      │ Type     │
├────────┼──────────────┼────────────────┼────────────┼──────────┤
│ 5      │ 0xEscrow...  │ 0xBob...       │ 1000 USDT  │ swap     │
│ 6      │ 0xEscrow...  │ 0xOperator...  │    3 USDT  │ fee      │
│ 7      │ 0xEscrow...  │ 0xAlice...     │   97 USDT  │ refund   │
└────────┴──────────────┴────────────────┴────────────┴──────────┘

Contract Logic (UnicitySwapBroker.sol):
  token.safeTransferFrom(escrow, recipient, amount);      // swap
  token.safeTransferFrom(escrow, feeRecipient, fees);     // fee
  token.safeTransferFrom(escrow, payback, refundAmount);  // refund
```

### revertERC20 (Timeout/Failure)

```
Transaction: 0xdef456...
Status: SUCCESS (receipt.status = 1)

ERC20 Transfer Events (sorted by logIndex):
┌────────┬──────────────┬────────────────┬────────────┬──────────┐
│ Index  │ From         │ To             │ Value      │ Type     │
├────────┼──────────────┼────────────────┼────────────┼──────────┤
│ 3      │ 0xEscrow...  │ 0xOperator...  │    3 USDT  │ fee      │
│ 4      │ 0xEscrow...  │ 0xAlice...     │ 1097 USDT  │ refund   │
└────────┴──────────────┴────────────────┴────────────┴──────────┘

Contract Logic (UnicitySwapBroker.sol):
  token.safeTransferFrom(escrow, feeRecipient, fees);     // fee
  token.safeTransferFrom(escrow, payback, refundAmount);  // refund
```

### refundERC20 (Post-Deal Cleanup)

```
Transaction: 0xghi789...
Status: SUCCESS (receipt.status = 1)

ERC20 Transfer Events (sorted by logIndex):
┌────────┬──────────────┬────────────────┬────────────┬──────────┐
│ Index  │ From         │ To             │ Value      │ Type     │
├────────┼──────────────┼────────────────┼────────────┼──────────┤
│ 2      │ 0xEscrow...  │ 0xOperator...  │   10 USDT  │ fee      │
│ 3      │ 0xEscrow...  │ 0xAlice...     │  100 USDT  │ refund   │
└────────┴──────────────┴────────────────┴────────────┴──────────┘

Contract Logic (UnicitySwapBroker.sol):
  token.safeTransferFrom(escrow, feeRecipient, fees);     // fee
  token.safeTransferFrom(escrow, payback, refundAmount);  // refund
```

## Comparison: Native vs ERC20 Parsing

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Native Currency (ETH/MATIC)                            │
├───────────────────────┬──────────────────────────────────────────────────┤
│ API Endpoint          │ Etherscan: txlistinternal (internal txs)         │
│ Data Source           │ EVM execution trace (CALL instructions)          │
│ Transfer Origin       │ FROM: Broker contract address                    │
│ Value Format          │ Native wei (1e18 = 1 ETH)                        │
│ Existing Method       │ getInternalTransactions(txHash)                  │
│ Transfer Count        │ Typically 2-3 (swap/fee/refund)                  │
│ Gas Cost              │ Lower (native transfers)                          │
│ Classification Logic  │ By array position + patterns                      │
└───────────────────────┴──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                    ERC20 Tokens (USDT/USDC/DAI)                          │
├───────────────────────┬──────────────────────────────────────────────────┤
│ API Endpoint          │ Etherscan: getLogs (event logs)                  │
│ Data Source           │ ERC20 Transfer events (topic0 = 0xddf252...)     │
│ Transfer Origin       │ FROM: Escrow address (topic1)                    │
│ Value Format          │ Token units (decimals vary: 6 for USDT, 18 DAI) │
│ New Method            │ getERC20Transfers(txHash, tokenAddress)          │
│ Transfer Count        │ Typically 2-3 (swap/fee/refund)                  │
│ Gas Cost              │ Higher (ERC20 token operations)                   │
│ Classification Logic  │ By logIndex position + patterns                   │
└───────────────────────┴──────────────────────────────────────────────────┘
```

## Error Handling Flow

```
                      getERC20Transfers(txHash, tokenAddress)
                                    │
                                    ▼
                        ┌───────────────────────┐
                        │ Check if API key set  │
                        └───────────┬───────────┘
                                    │
                     ┌──────────────┴──────────────┐
                     │ API Key Available?          │
                     └─────┬───────────────────┬───┘
                           │                   │
                        Yes│                   │No
                           ▼                   ▼
                ┌──────────────────┐   ┌──────────────────┐
                │ Try Etherscan    │   │ Skip to RPC      │
                │ getLogs API      │   │ Fallback         │
                └─────┬────────────┘   └──────────────────┘
                      │                         │
                      ▼                         │
                ┌──────────────────┐            │
                │ Success?         │            │
                └─────┬───────┬────┘            │
                      │       │                 │
                   Yes│       │No               │
                      │       └─────────────────┤
                      │                         │
                      │                         ▼
                      │              ┌──────────────────┐
                      │              │ Try RPC Node     │
                      │              │ getReceipt       │
                      │              └─────┬────────────┘
                      │                    │
                      │                    ▼
                      │              ┌──────────────────┐
                      │              │ Success?         │
                      │              └─────┬───────┬────┘
                      │                    │       │
                      │                 Yes│       │No
                      │                    │       │
                      └────────────────────┤       │
                                           │       ▼
                                           │  ┌──────────────────┐
                                           │  │ Return empty []  │
                                           │  │ Log error        │
                                           │  └──────────────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │ Parse logs       │
                                  │ Decode values    │
                                  │ Classify types   │
                                  └─────┬────────────┘
                                        │
                                        ▼
                                  ┌──────────────────┐
                                  │ Return transfers │
                                  └──────────────────┘
```

## Database Schema Addition (Optional)

```sql
-- Optional: Store parsed ERC20 transfers for caching/analytics
CREATE TABLE IF NOT EXISTS erc20_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  token_address TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  value TEXT NOT NULL,           -- Formatted amount
  transfer_type TEXT NOT NULL,   -- 'swap', 'fee', 'refund', 'unknown'
  log_index INTEGER NOT NULL,
  block_number INTEGER,
  created_at TEXT NOT NULL,

  FOREIGN KEY (deal_id) REFERENCES deals(id),
  UNIQUE(tx_hash, log_index)  -- Prevent duplicates
);

CREATE INDEX idx_erc20_transfers_deal ON erc20_transfers(deal_id);
CREATE INDEX idx_erc20_transfers_tx ON erc20_transfers(tx_hash);
```
