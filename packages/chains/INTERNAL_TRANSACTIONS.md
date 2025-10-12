# Internal Transaction Fetching for Broker Contracts

## Overview

The `getInternalTransactions()` method allows fetching and decoding internal transactions from broker contract calls to display detailed transaction history in the GUI.

## Background

When using the UnicitySwapBroker smart contract for atomic swaps, a single transaction to the broker contract executes multiple internal transfers:

- **Swap**: Transfer to recipient address (the actual swap amount)
- **Fee**: Transfer to fee recipient (commission payment)
- **Refund**: Transfer to payback address (surplus or timeout refunds)

Previously, the GUI would only show the main transaction to the broker contract, without visibility into these internal transfers. This feature adds the ability to fetch and classify these internal transactions.

## Configuration

### API Key Setup

Internal transaction fetching requires an Etherscan API key. Set up the API key in your chain configuration:

```typescript
// In your chain config
const config: ChainConfig = {
  chainId: 'ETH',
  rpcUrl: 'https://eth-rpc.example.com',
  confirmations: 12,
  operator: { address: '0x...' },
  brokerAddress: '0x...', // UnicitySwapBroker contract address
  etherscanApiKey: 'YOUR_ETHERSCAN_API_KEY', // Required for internal transactions
};
```

### Environment Variables

Alternatively, set the API key via environment variables:

```bash
# For Ethereum mainnet
ETHERSCAN_API_KEY=your_api_key_here

# For Sepolia testnet
ETHERSCAN_API_KEY=your_api_key_here

# For Polygon
POLYGONSCAN_API_KEY=your_api_key_here

# For BSC
BSCSCAN_API_KEY=your_api_key_here

# For Base
BASESCAN_API_KEY=your_api_key_here
```

## Usage

### Basic Example

```typescript
import { EthereumPlugin } from '@otc-broker/chains';

const plugin = new EthereumPlugin();
await plugin.init(config);

// Fetch internal transactions from a broker contract call
const txHash = '0x1234567890abcdef...';
const internalTxs = await plugin.getInternalTransactions(txHash);

// Display results
for (const tx of internalTxs) {
  console.log(`${tx.type}: ${tx.from} → ${tx.to}: ${tx.value} ETH`);
}
```

### Expected Output

For a successful swap transaction:

```
swap: 0xBrokerContract → 0xRecipient: 1.5 ETH
fee: 0xBrokerContract → 0xFeeRecipient: 0.003 ETH
refund: 0xBrokerContract → 0xPayback: 0.0001 ETH
```

For a revert/refund transaction:

```
fee: 0xBrokerContract → 0xFeeRecipient: 0.003 ETH
refund: 0xBrokerContract → 0xPayback: 1.4999 ETH
```

## Return Type

```typescript
Array<{
  from: string;      // Source address (typically broker contract)
  to: string;        // Destination address
  value: string;     // Amount in native currency (e.g., "1.5" for 1.5 ETH)
  type: 'swap' | 'fee' | 'refund' | 'unknown';
}>
```

## Transfer Classification Logic

The method classifies internal transfers based on their position in the transaction:

### Three or More Transfers (Successful Swap)
- **Index 0**: `swap` - Payout to recipient
- **Index 1**: `fee` - Commission to fee recipient
- **Index 2+**: `refund` - Surplus to payback address

### Two Transfers (Swap without surplus OR Revert with commission)
- **Index 0**: `fee` - Commission (or swap in some cases)
- **Index 1**: `refund` - Refund or surplus

### Single Transfer
- **Index 0**: `refund` - Simple refund or swap without commission

## Supported Networks

- Ethereum Mainnet (`ETH`)
- Sepolia Testnet (`SEPOLIA`)
- Polygon (`POLYGON`)
- Base (`BASE`)
- BSC (`BSC`)

All networks that extend `EthereumPlugin` automatically inherit this functionality.

## Error Handling

The method handles errors gracefully:

```typescript
const internalTxs = await plugin.getInternalTransactions(txHash);

if (internalTxs.length === 0) {
  // Could be:
  // 1. No internal transactions (e.g., failed transaction)
  // 2. API key not configured
  // 3. Broker contract not configured
  // 4. Network/API error
  console.log('No internal transactions found');
}
```

Check logs for specific error messages:
- `"Etherscan API not configured"` - API key missing
- `"Broker contract not configured"` - No broker address in config
- `"No internal transactions found"` - Transaction has no internal calls
- `"All internal transactions failed"` - Transaction reverted

## Rate Limiting

Etherscan API has rate limits:
- **Free tier**: 5 requests/second, 100,000 requests/day
- **Paid tier**: Higher limits based on plan

Consider implementing caching or request throttling for production use.

## GUI Integration Example

```typescript
// In your GUI code
async function displayTransactionDetails(txHash: string) {
  const plugin = getChainPlugin('ETH');

  // Fetch internal transactions
  const internalTxs = await plugin.getInternalTransactions?.(txHash);

  if (!internalTxs || internalTxs.length === 0) {
    // Display simple transaction view
    return renderSimpleTransaction(txHash);
  }

  // Display detailed view with internal transfers
  return renderDetailedTransaction(txHash, internalTxs);
}

function renderDetailedTransaction(txHash: string, internalTxs: InternalTransaction[]) {
  return (
    <div>
      <h3>Transaction Details</h3>
      <p>Hash: {txHash}</p>

      <h4>Internal Transfers:</h4>
      <ul>
        {internalTxs.map((tx, i) => (
          <li key={i}>
            <strong>{tx.type.toUpperCase()}</strong>:
            {tx.value} ETH → {shortenAddress(tx.to)}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## Testing

To test the feature with a real transaction:

1. Execute a swap via the broker contract on testnet
2. Get the transaction hash from the receipt
3. Call `getInternalTransactions()` with that hash
4. Verify the returned transfers match expected behavior

Example test transaction on Sepolia:
```typescript
// Replace with actual Sepolia broker transaction
const testTxHash = '0x...';
const internalTxs = await sepoliaPlugin.getInternalTransactions(testTxHash);
console.log(JSON.stringify(internalTxs, null, 2));
```

## Limitations

1. **Requires Etherscan API**: Not available for chains without Etherscan-compatible explorers
2. **Native transfers only**: Currently only decodes native currency (ETH/MATIC) internal transfers
3. **ERC-20 transfers**: Token transfers appear in Transfer events, not internal transactions
4. **Classification heuristic**: Transfer classification is based on position heuristics, not ABI decoding

## Future Enhancements

Potential improvements:
- ABI decoding to extract exact parameter names (recipient, feeRecipient, payback)
- Support for ERC-20 token transfer decoding via Transfer events
- Caching layer to reduce API calls
- Alternative data sources (The Graph, Alchemy, etc.)
