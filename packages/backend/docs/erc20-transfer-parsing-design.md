# ERC20 Transfer Parsing Design for Broker Contract Transactions

## Overview

This document outlines the design for parsing ERC20 Transfer events from broker contract transactions (swapERC20, revertERC20, refundERC20) to identify where tokens were sent (counterparty, fees, refunds).

## Context

The UnicitySwapBroker contract executes ERC20 token transfers using `safeTransferFrom` which emits standard ERC20 Transfer events. For each broker operation:

- **swapERC20**: Transfers to recipient (swap), feeRecipient (commission), payback (surplus)
- **revertERC20**: Transfers to feeRecipient (commission), payback (refund)
- **refundERC20**: Transfers to feeRecipient (commission), payback (refund)

Currently, the system only parses **native currency** internal transactions via Etherscan's `txlistinternal` API. We need equivalent parsing for **ERC20 transfers**.

## Technical Requirements

### ERC20 Transfer Event Signature
```solidity
event Transfer(address indexed from, address indexed to, uint256 value)
```

- **Event Topic0**: `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`
- **Topic1**: `from` address (indexed)
- **Topic2**: `to` address (indexed)
- **Data**: `value` (uint256, not indexed)

### Transfer Patterns

#### swapERC20 Pattern (3 transfers)
1. **Transfer 0**: `escrow → recipient` (swap amount)
2. **Transfer 1**: `escrow → feeRecipient` (commission)
3. **Transfer 2**: `escrow → payback` (surplus, if any)

#### revertERC20 Pattern (2 transfers)
1. **Transfer 0**: `escrow → feeRecipient` (commission)
2. **Transfer 1**: `escrow → payback` (refund)

#### refundERC20 Pattern (2 transfers)
1. **Transfer 0**: `escrow → feeRecipient` (commission)
2. **Transfer 1**: `escrow → payback` (refund)

### Edge Cases
- **Zero commission**: Only 1-2 transfers (no fee transfer)
- **Zero surplus**: Only 2 transfers for swap (no refund)
- **Failed transactions**: No transfers emitted (filter by receipt.status)
- **Multiple ERC20 tokens**: Must filter by specific token contract address
- **Non-broker transactions**: Ignore transfers not originating from broker operations

## Architecture Design

### 1. Location: EthereumPlugin Extension

**Rationale**:
- EthereumPlugin already handles Etherscan API integration
- Mirrors existing `getInternalTransactions()` method for native transfers
- Keeps chain-specific logic contained within the chain plugin

### 2. Method Structure

```typescript
/**
 * Fetch and decode ERC20 Transfer events from a broker contract transaction.
 * Parses Transfer events to identify swap payouts, commission payments, and refunds.
 *
 * @param txHash - Transaction hash to fetch ERC20 transfers for
 * @param tokenAddress - ERC20 token contract address to filter transfers
 * @returns Array of decoded ERC20 transfers with type classification
 */
async getERC20Transfers(
  txHash: string,
  tokenAddress: string
): Promise<Array<{
  from: string;
  to: string;
  value: string;        // Formatted amount (e.g., "100.5" USDT)
  type: 'swap' | 'fee' | 'refund' | 'unknown';
  logIndex: number;     // For ordering
}>>
```

### 3. Implementation Approach

#### Option A: Etherscan API (Primary)
Use Etherscan's `getLogs` API with event signature filtering:

```typescript
// Etherscan API call
GET https://api.etherscan.io/api
  ?module=logs
  &action=getLogs
  &address=<TOKEN_ADDRESS>
  &topic0=0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
  &topic0_1_opr=and
  &topic1=<FROM_ADDRESS_PADDED>
  &txhash=<TX_HASH>
  &apikey=<API_KEY>
```

**Pros**:
- Fast, single API call
- No RPC node load
- Works for historical transactions

**Cons**:
- Requires API key for production
- Rate limited
- Etherscan dependency

#### Option B: RPC Node (Fallback)
Use `eth_getTransactionReceipt` to fetch logs directly:

```typescript
const receipt = await provider.getTransactionReceipt(txHash);
const transferLogs = receipt.logs.filter(log =>
  log.address.toLowerCase() === tokenAddress.toLowerCase() &&
  log.topics[0] === TRANSFER_EVENT_TOPIC
);
```

**Pros**:
- No external dependency
- Works without API key
- Real-time data

**Cons**:
- Requires decoding logs manually
- RPC node must be reliable
- Slower for batch operations

#### Recommended Strategy: Hybrid Approach
1. **Try Etherscan API first** (if API key available)
2. **Fallback to RPC node** if Etherscan fails or unavailable
3. **Cache results** to avoid repeated queries

### 4. Transfer Classification Logic

```typescript
function classifyERC20Transfers(
  transfers: Array<TransferLog>,
  brokerAddress: string,
  escrowAddress: string
): Array<ClassifiedTransfer> {
  // Filter: Only transfers FROM escrow (ignore incoming deposits)
  const escrowTransfers = transfers.filter(t =>
    t.from.toLowerCase() === escrowAddress.toLowerCase()
  );

  // Sort by log index (execution order)
  escrowTransfers.sort((a, b) => a.logIndex - b.logIndex);

  // Classify based on position and count
  return escrowTransfers.map((transfer, index) => {
    let type: 'swap' | 'fee' | 'refund' | 'unknown';

    if (escrowTransfers.length === 1) {
      // Single transfer: Could be swap-only or refund-only
      type = 'refund';
    } else if (escrowTransfers.length === 2) {
      // Two transfers: fee + refund (revert/refund) OR swap + fee (no surplus)
      if (index === 0) {
        type = 'fee';  // First transfer is typically fee
      } else {
        type = 'refund';
      }
    } else if (escrowTransfers.length >= 3) {
      // Three transfers: swap + fee + refund
      if (index === 0) {
        type = 'swap';
      } else if (index === 1) {
        type = 'fee';
      } else {
        type = 'refund';
      }
    } else {
      type = 'unknown';
    }

    return { ...transfer, type };
  });
}
```

### 5. Data Structure

```typescript
interface ERC20TransferEvent {
  from: string;           // Transfer sender (escrow)
  to: string;             // Transfer recipient
  value: string;          // Formatted amount with decimals
  type: TransferType;     // Classification
  logIndex: number;       // Position in transaction logs
  tokenAddress: string;   // ERC20 contract address
  decimals: number;       // Token decimals for formatting
}

type TransferType = 'swap' | 'fee' | 'refund' | 'unknown';
```

## Integration Points

### 1. Engine Integration

**Location**: `packages/backend/src/engine/Engine.ts`

When processing completed broker transactions:

```typescript
// After broker transaction confirms
if (queueItem.purpose === 'BROKER_SWAP' || queueItem.purpose === 'BROKER_REVERT') {
  const txHash = queueItem.submittedTx.txid;
  const tokenAddress = extractTokenAddress(queueItem.asset);

  // Fetch ERC20 transfers
  const transfers = await plugin.getERC20Transfers(txHash, tokenAddress);

  // Store transfers for display in deal status
  deal.events.push({
    t: new Date().toISOString(),
    msg: `ERC20 transfers for ${queueItem.purpose}: ${JSON.stringify(transfers)}`
  });
}
```

### 2. API Integration

**Location**: `packages/backend/src/api/rpc-server.ts`

Extend `otc.status` response to include ERC20 transfer details:

```typescript
interface DealStatusResponse {
  // ... existing fields
  erc20Transfers?: {
    [chainId: string]: {
      [txHash: string]: Array<ERC20TransferEvent>;
    };
  };
}
```

### 3. Queue Item Enhancement

**Location**: `packages/core/src/types.ts`

Add optional field to track ERC20 transfer details:

```typescript
interface QueueItem {
  // ... existing fields

  /**
   * Parsed ERC20 transfers from broker transaction (if applicable)
   * Only populated for BROKER_SWAP, BROKER_REVERT, BROKER_REFUND purposes
   */
  erc20Transfers?: Array<{
    to: string;
    value: string;
    type: 'swap' | 'fee' | 'refund';
  }>;
}
```

## API Considerations

### Etherscan getLogs Endpoint

**Documentation**: https://docs.etherscan.io/api-endpoints/logs

```
GET /api
  ?module=logs
  &action=getLogs
  &address=<TOKEN_CONTRACT>     // ERC20 token address
  &topic0=<TRANSFER_TOPIC>      // Transfer event signature
  &topic1=<FROM_ADDRESS>        // Optional: filter by sender
  &txhash=<TX_HASH>            // Filter by specific transaction
  &apikey=<YOUR_API_KEY>
```

**Response Format**:
```json
{
  "status": "1",
  "message": "OK",
  "result": [
    {
      "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "topics": [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x000000000000000000000000abcd...",  // from
        "0x000000000000000000000000ef12..."   // to
      ],
      "data": "0x00000000000000000000000000000000000000000000000000000000000f4240",  // value
      "blockNumber": "0x123456",
      "transactionHash": "0xabc...",
      "transactionIndex": "0x1",
      "logIndex": "0x5",
      "timeStamp": "0x641a7890"
    }
  ]
}
```

### Rate Limiting

Etherscan API rate limits:
- **Free tier**: 5 calls/second, 10,000 calls/day
- **Paid tier**: Higher limits based on plan

**Mitigation**:
- Cache ERC20 transfer results in database
- Only query once per confirmed transaction
- Use RPC fallback for real-time needs

## Implementation Plan

### Phase 1: Core Method (EthereumPlugin)
1. Add `getERC20Transfers()` method to EthereumPlugin
2. Implement Etherscan getLogs API call
3. Add RPC receipt parsing fallback
4. Add transfer classification logic
5. Add unit tests for classification

### Phase 2: EtherscanAPI Extension
1. Add `getERC20TransfersByTxHash()` to EtherscanAPI utility
2. Handle API response parsing and error cases
3. Format amounts using token decimals

### Phase 3: Engine Integration
1. Call `getERC20Transfers()` after broker transactions confirm
2. Store results in deal events log
3. Add to queue item metadata

### Phase 4: API Enhancement
1. Extend `otc.status` to include ERC20 transfer details
2. Add filtering to show only relevant transfers
3. Document new response fields

### Phase 5: Testing
1. Test with mainnet USDT/USDC broker transactions
2. Test classification for all broker operation types
3. Test edge cases (zero fees, zero surplus)
4. Test fallback behavior when Etherscan unavailable

## Example Usage

```typescript
// In Engine.ts after broker transaction confirms
const plugin = this.chains.getPlugin('ETH');
const tokenAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC
const txHash = '0xabc123...';

const transfers = await plugin.getERC20Transfers(txHash, tokenAddress);

console.log(transfers);
// [
//   { from: '0xescrow...', to: '0xbob...', value: '1000.0', type: 'swap', logIndex: 5 },
//   { from: '0xescrow...', to: '0xoperator...', value: '3.0', type: 'fee', logIndex: 6 },
//   { from: '0xescrow...', to: '0xalice...', value: '97.0', type: 'refund', logIndex: 7 }
// ]
```

## Security Considerations

1. **Validate token addresses**: Always verify token address matches expected asset
2. **Check transaction success**: Only parse logs from successful transactions (receipt.status === 1)
3. **Verify escrow source**: Only count transfers FROM the escrow address
4. **Prevent log spoofing**: Use official Etherscan API or trusted RPC nodes
5. **Handle reorgs**: Check transaction confirmations before finalizing

## Performance Considerations

1. **Cache results**: Store parsed transfers in database to avoid repeated queries
2. **Batch API calls**: If processing multiple transactions, batch where possible
3. **Async processing**: Parse transfers asynchronously after confirmation
4. **Pagination**: For deals with many queue items, fetch transfers on-demand

## Future Enhancements

1. **Multi-token support**: Parse transfers for multiple tokens in same transaction
2. **Event indexing**: Build local index of ERC20 transfers for faster queries
3. **GraphQL endpoint**: Expose transfer data via GraphQL for richer queries
4. **Notification system**: Alert users when specific transfer types complete
5. **Analytics dashboard**: Aggregate transfer data for reporting

## Comparison: Native vs ERC20 Transfer Parsing

| Aspect | Native Transfers | ERC20 Transfers |
|--------|-----------------|-----------------|
| **API Endpoint** | `txlistinternal` | `getLogs` |
| **Event Source** | Internal transactions | ERC20 Transfer events |
| **From Field** | Broker contract | Escrow address |
| **Decoding** | Direct value field | Decode log data + decimals |
| **Classification** | By position in array | By log index + pattern |
| **Existing Method** | `getInternalTransactions()` | `getERC20Transfers()` (new) |

## Constants

```typescript
// ERC20 Transfer event signature
export const ERC20_TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Known ERC20 token addresses (for testing and validation)
export const KNOWN_TOKENS: Record<string, Record<string, string>> = {
  ETH: {
    USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    DAI: '0x6b175474e89094c44da98b954eedeac495271d0f'
  },
  POLYGON: {
    USDT: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
    USDC: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
    DAI: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063'
  }
};
```

## References

- Etherscan API Docs: https://docs.etherscan.io/api-endpoints/logs
- ERC20 Standard: https://eips.ethereum.org/EIPS/eip-20
- UnicitySwapBroker Contract: `/contracts/src/UnicitySwapBroker.sol`
- Existing Internal TX Parsing: `EthereumPlugin.getInternalTransactions()`
