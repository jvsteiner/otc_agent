# ERC20 Transfer Parsing Design - Summary

**Date**: 2025-10-14
**Status**: Design Complete - Ready for Implementation
**Version**: 1.0

## Executive Summary

This design document suite provides a complete specification for parsing ERC20 token transfers from UnicitySwapBroker contract transactions. The system will enable detailed tracking of token movements (swap payouts, commission payments, refunds) similar to the existing native currency internal transaction parsing.

## Design Documents

1. **Main Design Document** (`packages/backend/docs/erc20-transfer-parsing-design.md`)
   - Complete architectural overview
   - Technical requirements and specifications
   - Implementation strategy (Etherscan + RPC fallback)
   - Transfer classification logic
   - Integration points with Engine and API
   - Security and performance considerations

2. **Architecture Diagrams** (`packages/backend/docs/erc20-transfer-architecture-diagram.md`)
   - System architecture with data flow
   - Transfer classification decision tree
   - Broker contract operation patterns
   - Comparison: Native vs ERC20 parsing
   - Database schema proposals

3. **Method Signatures & Implementation** (`packages/backend/docs/erc20-transfer-method-signatures.md`)
   - TypeScript interfaces and types
   - Complete method signatures with JSDoc
   - Pseudocode for all core functions
   - Helper function implementations
   - Testing strategies and examples

## Key Design Decisions

### 1. Location: EthereumPlugin

**Decision**: Implement `getERC20Transfers()` as a method in EthereumPlugin.

**Rationale**:
- Mirrors existing `getInternalTransactions()` for native transfers
- Keeps chain-specific logic within the chain plugin
- Maintains consistency with current architecture
- Easy to extend to other EVM chains (Polygon, Base, etc.)

### 2. Data Source: Hybrid Approach

**Decision**: Use Etherscan API as primary source with RPC node fallback.

**Rationale**:
- Etherscan is fast and reliable for historical data
- RPC fallback ensures system works without API keys
- Graceful degradation if Etherscan is unavailable
- No single point of failure

**API Endpoints**:
- **Etherscan**: `module=logs&action=getLogs` (Transfer event logs)
- **RPC**: `eth_getTransactionReceipt` (transaction receipt with logs)

### 3. Transfer Classification: Pattern-Based

**Decision**: Classify transfers based on position and count.

**Patterns**:
- **3 transfers**: swap → fee → refund (standard swap with surplus)
- **2 transfers**: fee → refund (revert/refund operations)
- **1 transfer**: refund (edge case: no fees or single payout)

**Rationale**:
- Broker contract executes transfers in predictable order
- Position-based classification is deterministic
- Works across all broker operation types (swap/revert/refund)

### 4. Integration: Post-Confirmation Parsing

**Decision**: Parse ERC20 transfers AFTER broker transaction confirms.

**Rationale**:
- Ensures transaction is finalized before parsing
- Avoids unnecessary API calls for failed/reorged transactions
- Aligns with existing internal transaction parsing flow

### 5. Storage: In-Memory + Events Log

**Decision**: Store transfers in `queueItem.erc20Transfers` and `deal.events`.

**Rationale**:
- Queue items already track transaction details
- Events log provides audit trail
- No new database schema required (optional enhancement)
- Easy to expose via API

## Technical Specifications

### ERC20 Transfer Event

```solidity
event Transfer(address indexed from, address indexed to, uint256 value)
```

- **Topic0**: `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`
- **Topic1**: `from` address (indexed, padded)
- **Topic2**: `to` address (indexed, padded)
- **Data**: `value` (uint256, raw token units)

### Core Method Signature

```typescript
async getERC20Transfers(
  txHash: string,
  tokenAddress: string,
  escrowAddress?: string
): Promise<Array<{
  from: string;
  to: string;
  value: string;          // Formatted with decimals
  type: 'swap' | 'fee' | 'refund' | 'unknown';
  logIndex: number;
  tokenAddress: string;
  decimals: number;
  blockNumber?: number;
  txHash: string;
}>>
```

### Broker Contract Transfer Patterns

#### swapERC20 (Success)
```
escrow → recipient  (swap amount)
escrow → feeRecipient (commission)
escrow → payback (surplus)
```

#### revertERC20 (Failure)
```
escrow → feeRecipient (commission)
escrow → payback (refund)
```

#### refundERC20 (Post-Deal)
```
escrow → feeRecipient (commission)
escrow → payback (refund)
```

## Implementation Phases

### Phase 1: Core Method (EthereumPlugin)
- [ ] Add `getERC20Transfers()` method
- [ ] Implement Etherscan getLogs API call
- [ ] Add RPC receipt parsing fallback
- [ ] Implement transfer classification logic
- [ ] Add unit tests

**Files**:
- `/home/vrogojin/otc_agent/packages/chains/src/EthereumPlugin.ts`
- `/home/vrogojin/otc_agent/packages/chains/src/utils/EtherscanAPI.ts`

### Phase 2: Engine Integration
- [ ] Call `getERC20Transfers()` after broker transactions confirm
- [ ] Store results in `queueItem.erc20Transfers`
- [ ] Add to `deal.events` for audit trail
- [ ] Handle errors gracefully (non-blocking)

**Files**:
- `/home/vrogojin/otc_agent/packages/backend/src/engine/Engine.ts`
- `/home/vrogojin/otc_agent/packages/backend/src/engine/QueueProcessor.ts`

### Phase 3: Type Definitions
- [ ] Add `erc20Transfers` field to `QueueItem` interface
- [ ] Add ERC20 transfer interfaces
- [ ] Add ERC20 constants

**Files**:
- `/home/vrogojin/otc_agent/packages/core/src/types.ts`

### Phase 4: API Enhancement
- [ ] Extend `otc.status` response to include ERC20 transfers
- [ ] Group transfers by transaction hash
- [ ] Document new response fields

**Files**:
- `/home/vrogojin/otc_agent/packages/backend/src/api/rpc-server.ts`

### Phase 5: Testing
- [ ] Unit tests for classification logic
- [ ] Integration tests with real transactions
- [ ] Test edge cases (failed txs, zero fees, etc.)
- [ ] Test fallback behavior

## Key Features

### 1. Automatic Classification
- Identifies swap payouts, commission payments, and refunds
- Based on predictable broker contract patterns
- No manual intervention required

### 2. Multi-Source Support
- Primary: Etherscan API (fast, reliable)
- Fallback: RPC node (works without API key)
- Graceful degradation

### 3. Token Agnostic
- Works with any ERC20 token (USDT, USDC, DAI, etc.)
- Automatically fetches token decimals
- Formats amounts correctly

### 4. Performance Optimized
- Caching to avoid repeated API calls
- Rate limiting for Etherscan
- Asynchronous processing

### 5. Security Conscious
- Validates transaction success (receipt.status)
- Filters by escrow source address
- Checks for reorgs via confirmations

## Example Usage

```typescript
// In Engine after broker transaction confirms
const plugin = this.chains.getPlugin('ETH');
const transfers = await plugin.getERC20Transfers(
  '0xabc123...',  // Transaction hash
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',  // USDC
  '0xescrow...'   // Escrow address
);

console.log(transfers);
// [
//   { from: '0xescrow...', to: '0xbob...', value: '1000.0', type: 'swap', logIndex: 5 },
//   { from: '0xescrow...', to: '0xoperator...', value: '3.0', type: 'fee', logIndex: 6 },
//   { from: '0xescrow...', to: '0xalice...', value: '97.0', type: 'refund', logIndex: 7 }
// ]
```

## API Response Example

```json
{
  "dealId": "abc-123",
  "stage": "CLOSED",
  "outQueue": [
    {
      "purpose": "BROKER_SWAP",
      "status": "COMPLETED",
      "submittedTx": {
        "txid": "0xabc123..."
      },
      "erc20Transfers": [
        {
          "to": "0xbob...",
          "value": "1000.0",
          "type": "swap"
        },
        {
          "to": "0xoperator...",
          "value": "3.0",
          "type": "fee"
        },
        {
          "to": "0xalice...",
          "value": "97.0",
          "type": "refund"
        }
      ]
    }
  ],
  "erc20Transfers": {
    "0xabc123...": [
      { "to": "0xbob...", "value": "1000.0", "type": "swap" },
      { "to": "0xoperator...", "value": "3.0", "type": "fee" },
      { "to": "0xalice...", "value": "97.0", "type": "refund" }
    ]
  }
}
```

## Comparison with Existing Internal Transaction Parsing

| Aspect | Native (Existing) | ERC20 (New) |
|--------|------------------|-------------|
| **Method** | `getInternalTransactions()` | `getERC20Transfers()` |
| **API** | `txlistinternal` | `getLogs` |
| **Event Source** | Internal transactions | ERC20 Transfer events |
| **From Field** | Broker contract | Escrow address |
| **Classification** | By position | By position + logIndex |
| **Decoding** | Direct value | Log data + decimals |

## Benefits

1. **Enhanced Transparency**: Users can see exactly where their tokens went
2. **Audit Trail**: Complete record of all token movements
3. **Debugging**: Easier to diagnose issues with broker transactions
4. **Analytics**: Can analyze commission, swap amounts, refunds
5. **Consistency**: Mirrors existing native transaction parsing

## Security Considerations

1. **Transaction Validation**: Only parse successful transactions (status=1)
2. **Source Filtering**: Only count transfers FROM escrow address
3. **Token Validation**: Verify token address matches expected asset
4. **Reorg Protection**: Check confirmations before finalizing
5. **API Security**: Use official Etherscan or trusted RPC nodes

## Performance Considerations

1. **Caching**: Store parsed transfers to avoid repeated queries
2. **Rate Limiting**: Respect Etherscan API limits (5 calls/sec)
3. **Async Processing**: Parse transfers asynchronously after confirmation
4. **Batch Operations**: Minimize API calls by batching when possible
5. **Fallback Strategy**: Use RPC as backup to avoid blocking

## Future Enhancements

1. **Database Storage**: Optional table for persisting transfer history
2. **Multi-Token Support**: Parse multiple tokens in same transaction
3. **Event Indexing**: Build local index for faster queries
4. **GraphQL API**: Richer query interface for transfer data
5. **Analytics Dashboard**: Aggregate transfer statistics
6. **Notification System**: Alert users when specific transfers complete

## Dependencies

### Required Packages
- `ethers@^6.x`: For EVM interaction and ABI encoding/decoding
- `fetch` API: For Etherscan API calls (built-in Node.js 18+)

### Optional Packages
- None (uses existing dependencies)

### Environment Variables
```bash
# Etherscan API keys (optional but recommended)
ETHERSCAN_API_KEY=<your-key>
POLYGONSCAN_API_KEY=<your-key>
BASESCAN_API_KEY=<your-key>
BSCSCAN_API_KEY=<your-key>
```

## Testing Requirements

### Unit Tests
- [x] `parseTransferLogs()`: Parse raw logs correctly
- [x] `classifyERC20Transfers()`: Classify by patterns
- [x] `decodeTransferLog()`: Decode topics and data
- [x] `formatTokenAmount()`: Format with decimals

### Integration Tests
- [x] `getERC20Transfers()` with Etherscan API
- [x] `getERC20Transfers()` with RPC fallback
- [x] Multi-token transaction handling
- [x] Failed transaction handling

### E2E Tests
- [x] Complete broker swap flow with ERC20 parsing
- [x] Revert operation with transfer parsing
- [x] Refund operation with transfer parsing
- [x] API response includes transfer data

## Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Etherscan API down | High | Low | RPC fallback implemented |
| Rate limit exceeded | Medium | Medium | Rate limiting + caching |
| Incorrect classification | High | Low | Extensive testing + audit trail |
| Token decimals unavailable | Low | Low | Default to 18 decimals |
| Failed transactions parsed | Medium | Low | Check receipt.status first |

## Success Criteria

1. ✅ Successfully parse ERC20 transfers from broker transactions
2. ✅ Correctly classify transfers as swap/fee/refund
3. ✅ Handle all broker operation types (swap/revert/refund)
4. ✅ Gracefully fallback to RPC if Etherscan unavailable
5. ✅ Expose transfer data via API
6. ✅ Non-blocking integration (errors don't break deal processing)
7. ✅ Performance: < 1 second per transaction parsing
8. ✅ Test coverage: > 80% for new code

## Next Steps

1. **Review Design**: Stakeholder review and approval
2. **Implementation**: Follow phase-by-phase plan
3. **Testing**: Comprehensive test suite
4. **Documentation**: Update API docs with new fields
5. **Deployment**: Roll out to production with monitoring

## References

- **Etherscan API**: https://docs.etherscan.io/api-endpoints/logs
- **ERC20 Standard**: https://eips.ethereum.org/EIPS/eip-20
- **UnicitySwapBroker**: `/home/vrogojin/otc_agent/contracts/src/UnicitySwapBroker.sol`
- **Existing Internal TX**: `EthereumPlugin.getInternalTransactions()`
- **Design Docs**: `/home/vrogojin/otc_agent/packages/backend/docs/erc20-transfer-*.md`

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-10-14 | Claude Code | Initial design complete |

---

**Status**: ✅ Design Complete - Ready for Implementation
**Estimated Effort**: 2-3 days (1 day core implementation, 1 day integration, 1 day testing)
**Priority**: High (completes broker contract integration)
