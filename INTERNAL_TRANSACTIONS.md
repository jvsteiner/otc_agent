# Internal Transaction Support for Broker Contracts

## Overview
The OTC broker engine now supports fetching and displaying internal transactions from broker contract calls. This feature provides transparency into how broker contracts distribute funds during swap execution, including swap payouts, commission payments, and refunds.

## Implementation Details

### 1. Chain Plugin Support
The `ChainPlugin` interface now includes an optional `getInternalTransactions` method:
```typescript
getInternalTransactions?(txHash: string): Promise<Array<{
  from: string;
  to: string;
  value: string;
  type: 'swap' | 'fee' | 'refund' | 'unknown';
}>>;
```

### 2. EthereumPlugin Implementation
The `EthereumPlugin` class implements this method to:
- Fetch internal transactions from Etherscan API
- Filter to only show outgoing transfers from the broker contract
- Classify transfers based on their position and pattern:
  - **First transfer (index 0)**: Swap payout to recipient
  - **Second transfer (index 1)**: Commission to fee recipient
  - **Third+ transfers (index 2+)**: Surplus/refund to payback address

### 3. Backend API Enhancement
The `otc.status` RPC endpoint now:
- Fetches internal transactions for broker contract calls (BROKER_SWAP, BROKER_REVERT, BROKER_REFUND)
- Adds an `internalTransactions` field to transaction objects in the response
- Handles errors gracefully - if fetching fails, the status response still works

## Transaction Classification
Internal transactions are classified into types:
- **`swap`**: Main swap payout to the recipient address
- **`fee`**: Commission payment to the operator
- **`refund`**: Surplus or timeout refund to payback address
- **`unknown`**: Unclassified transfers

## API Response Format
The enhanced `otc.status` response now includes:
```json
{
  "transactions": [
    {
      "purpose": "BROKER_SWAP",
      "chainId": "ETH",
      "submittedTx": { "txid": "0x..." },
      "internalTransactions": [
        {
          "from": "0xBrokerContract...",
          "to": "0xRecipient...",
          "value": "1000000000000000000",
          "type": "swap"
        },
        {
          "from": "0xBrokerContract...",
          "to": "0xOperator...",
          "value": "3000000000000000",
          "type": "fee"
        }
      ]
    }
  ]
}
```

## Requirements
- **Etherscan API Key**: For production use, configure an Etherscan API key in the chain configuration
- **Broker Contract**: Internal transactions are only fetched for chains with configured broker contracts
- **EVM Chains Only**: This feature is specific to EVM chains (Ethereum, Polygon, Base, BSC, etc.)

## Backward Compatibility
- Plugins without `getInternalTransactions` support are handled gracefully
- The feature is optional - if unavailable or failing, the status response continues to work
- Non-EVM chains (like Unicity) don't have this feature and work as before

## Testing
Use the provided test script `test-internal-txs.js` to verify:
1. Internal transactions are correctly fetched
2. Transaction types are properly classified
3. Error handling works as expected

## Future Enhancements
- Cache internal transactions to reduce API calls
- Support for other block explorers besides Etherscan
- More detailed transaction classification based on method signatures
- GUI enhancements to visualize internal transaction flow