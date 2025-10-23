# ERC20 Transfer Parsing - Quick Reference

## One-Page Overview

### Problem
Broker contract (swapERC20/revertERC20/refundERC20) emits ERC20 Transfer events but we don't currently parse them to show where tokens went (counterparty, fees, refunds).

### Solution
Add `getERC20Transfers()` method to EthereumPlugin that fetches Transfer event logs and classifies them as swap/fee/refund based on position.

## Key Constants

```typescript
// ERC20 Transfer event signature
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Token addresses
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const USDC_POLYGON = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const USDT_POLYGON = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f';
```

## Quick Method Reference

### 1. Main Method (EthereumPlugin)

```typescript
await plugin.getERC20Transfers(
  txHash: string,
  tokenAddress: string,
  escrowAddress?: string
): Promise<ERC20TransferEvent[]>

// Returns:
// [
//   { from, to, value, type: 'swap', logIndex: 5 },
//   { from, to, value, type: 'fee', logIndex: 6 },
//   { from, to, value, type: 'refund', logIndex: 7 }
// ]
```

### 2. Etherscan API (EtherscanAPI)

```typescript
await etherscanAPI.getERC20TransfersByTxHash(
  txHash: string,
  tokenAddress: string
): Promise<RawTransferLog[]>

// API: module=logs&action=getLogs&address=<token>&topic0=<transfer>&txhash=<hash>
```

### 3. Classification Logic (Helper)

```typescript
classifyERC20Transfers(
  transfers: Transfer[],
  escrowAddress: string
): ClassifiedTransfer[]

// Logic:
// 3 transfers → swap, fee, refund
// 2 transfers → fee, refund
// 1 transfer → refund
```

## Classification Patterns

```
swapERC20 (3 transfers):
  [0] escrow → recipient    (SWAP)
  [1] escrow → feeRecipient (FEE)
  [2] escrow → payback      (REFUND)

revertERC20 (2 transfers):
  [0] escrow → feeRecipient (FEE)
  [1] escrow → payback      (REFUND)

refundERC20 (2 transfers):
  [0] escrow → feeRecipient (FEE)
  [1] escrow → payback      (REFUND)
```

## Data Flow (30 seconds)

```
1. Broker tx confirms
   ↓
2. Engine detects BROKER_SWAP/REVERT/REFUND
   ↓
3. Call plugin.getERC20Transfers(txHash, tokenAddr, escrowAddr)
   ↓
4. Try Etherscan API → getLogs
   ↓ (if fails)
5. Fallback to RPC → getTransactionReceipt
   ↓
6. Parse logs: decode from/to/value
   ↓
7. Filter: only transfers FROM escrow
   ↓
8. Sort: by logIndex
   ↓
9. Classify: by position (swap/fee/refund)
   ↓
10. Store in queueItem.erc20Transfers
    ↓
11. Return via API: otc.status
```

## Integration Points

### Engine.ts
```typescript
// After broker tx confirms
if (queueItem.purpose === 'BROKER_SWAP') {
  const tokenAddress = extractTokenAddress(queueItem.asset);
  const transfers = await plugin.getERC20Transfers(
    queueItem.submittedTx.txid,
    tokenAddress,
    queueItem.from.address
  );
  queueItem.erc20Transfers = transfers.map(t => ({
    to: t.to,
    value: t.value,
    type: t.type
  }));
}
```

### API Response (rpc-server.ts)
```typescript
{
  "dealId": "abc-123",
  "outQueue": [{
    "purpose": "BROKER_SWAP",
    "erc20Transfers": [
      { "to": "0xbob...", "value": "1000.0", "type": "swap" },
      { "to": "0xop...", "value": "3.0", "type": "fee" },
      { "to": "0xalice...", "value": "97.0", "type": "refund" }
    ]
  }]
}
```

## Files to Modify

| File | Changes |
|------|---------|
| `packages/chains/src/EthereumPlugin.ts` | Add `getERC20Transfers()` method |
| `packages/chains/src/utils/EtherscanAPI.ts` | Add `getERC20TransfersByTxHash()` |
| `packages/core/src/types.ts` | Add `erc20Transfers?: Array<{to, value, type}>` to QueueItem |
| `packages/backend/src/engine/Engine.ts` | Call `getERC20Transfers()` after broker confirms |
| `packages/backend/src/api/rpc-server.ts` | Include `erc20Transfers` in status response |

## Implementation Checklist

- [ ] Add constants (TRANSFER_TOPIC, known tokens)
- [ ] Add interfaces (ERC20TransferEvent, RawTransferLog)
- [ ] Implement `decodeTransferLog(topics, data)`
- [ ] Implement `parseTransferLogs(rawLogs, tokenAddr, decimals)`
- [ ] Implement `classifyERC20Transfers(transfers, escrow)`
- [ ] Implement `EtherscanAPI.getERC20TransfersByTxHash()`
- [ ] Implement `EthereumPlugin.getERC20Transfers()`
- [ ] Add Engine integration (call after confirm)
- [ ] Add API response field (erc20Transfers)
- [ ] Write unit tests (parse, classify, decode)
- [ ] Write integration tests (Etherscan, RPC fallback)
- [ ] Test with real mainnet transactions

## Testing Commands

```bash
# Unit tests
npm test packages/chains/test/erc20-parsing.test.ts

# Integration tests
npm test packages/backend/test/erc20-broker-integration.test.ts

# E2E test with real transaction
node packages/tools/test-erc20-parsing.js --tx=0xabc123... --token=0xusdc...
```

## Example Real Transaction

```typescript
// Real USDC swap on Ethereum
const txHash = '0x...'; // Find real tx from Etherscan
const tokenAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // USDC

const transfers = await plugin.getERC20Transfers(txHash, tokenAddress);

console.log(transfers);
// Expected output:
// [
//   { from: '0xescrow', to: '0xrecipient', value: '1000.0', type: 'swap' },
//   { from: '0xescrow', to: '0xoperator', value: '3.0', type: 'fee' },
//   { from: '0xescrow', to: '0xpayback', value: '97.0', type: 'refund' }
// ]
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Transaction not found | Return empty array `[]` |
| Transaction failed (status=0) | Return empty array `[]` |
| Etherscan API down | Fallback to RPC |
| RPC also fails | Return empty array `[]`, log error |
| Token decimals unavailable | Use default 18 decimals |
| No transfers found | Return empty array `[]` |

## Performance Targets

| Metric | Target | Actual |
|--------|--------|--------|
| Parse time (Etherscan) | < 500ms | TBD |
| Parse time (RPC) | < 1000ms | TBD |
| Cache hit rate | > 80% | TBD |
| API call rate | < 5/sec | TBD |

## Debugging

### Check Etherscan API directly
```bash
curl "https://api.etherscan.io/api?module=logs&action=getLogs&address=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&topic0=0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef&txhash=0xabc...&apikey=YOUR_KEY"
```

### Check RPC directly
```bash
curl -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_getTransactionReceipt","params":["0xabc..."],"id":1}' \
  https://ethereum-rpc.publicnode.com
```

### Check transfer classification
```typescript
console.log('Transfer count:', transfers.length);
console.log('Transfer types:', transfers.map(t => t.type));
console.log('First transfer:', transfers[0]);
```

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| No transfers returned | Wrong token address | Verify token address matches asset |
| Wrong classification | Not filtering by escrow | Pass escrowAddress parameter |
| API error 403 | No API key | Set ETHERSCAN_API_KEY env var |
| Rate limit error | Too many calls | Add rate limiting delay |
| Decimal formatting wrong | Wrong decimals | Verify token.decimals() call |

## Related Code References

- Broker contract: `/home/vrogojin/otc_agent/contracts/src/UnicitySwapBroker.sol`
- Native internal TX: `EthereumPlugin.getInternalTransactions()` (line 1703)
- Etherscan API: `packages/chains/src/utils/EtherscanAPI.ts`
- Queue processing: `packages/backend/src/engine/QueueProcessor.ts`

## API Endpoints Used

### Etherscan getLogs
```
GET https://api.etherscan.io/api
  ?module=logs
  &action=getLogs
  &address=<TOKEN>           # ERC20 contract
  &topic0=<TRANSFER_TOPIC>   # Transfer event signature
  &txhash=<TX_HASH>         # Specific transaction
  &apikey=<API_KEY>
```

### RPC getTransactionReceipt
```json
{
  "jsonrpc": "2.0",
  "method": "eth_getTransactionReceipt",
  "params": ["0xabc..."],
  "id": 1
}
```

## Comparison Matrix

|  | Native (Current) | ERC20 (New) |
|--|-----------------|-------------|
| **Method** | getInternalTransactions | getERC20Transfers |
| **Source** | Internal transactions | Transfer events |
| **API** | txlistinternal | getLogs |
| **From** | Broker contract | Escrow address |
| **Format** | Native ETH/MATIC | Token units |
| **Status** | ✅ Implemented | 📝 Design ready |

## Next Actions

1. ✅ Design complete
2. ⏳ Review and approval
3. ⏳ Implement core method
4. ⏳ Add Engine integration
5. ⏳ Write tests
6. ⏳ Deploy to testnet
7. ⏳ Deploy to mainnet

**Estimated Time**: 2-3 days
**Risk Level**: Low (non-breaking addition)
**Impact**: High (completes broker transparency)
