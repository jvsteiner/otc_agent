# Chain Plugins Module

## Overview

The `packages/chains` module provides a unified abstraction layer for interacting with multiple blockchain networks in the OTC broker system. It implements a plugin-based architecture that allows the broker engine to seamlessly work with different blockchain types (UTXO-based, EVM-based, and potentially others) through a common interface.

## Purpose

This module serves as the blockchain interaction layer for the OTC broker, handling:

1. **Escrow Account Management**: Deterministic HD wallet generation for each deal party
2. **Deposit Tracking**: Monitoring and confirming incoming deposits to escrow addresses
3. **Transaction Submission**: Broadcasting distribution transactions with proper nonce/UTXO management
4. **Price Oracles**: Fetching native currency prices for commission calculations
5. **Gas Management**: Ensuring sufficient gas for transaction execution
6. **Chain-Specific Logic**: Abstracting away differences between blockchain architectures

## Architecture

### Core Interface: ChainPlugin

The `ChainPlugin` interface defines the contract that all blockchain adapters must implement:

```typescript
interface ChainPlugin {
  readonly chainId: ChainId;

  // Lifecycle
  init(cfg: ChainConfig): Promise<void>;

  // Escrow management
  generateEscrowAccount(asset: AssetCode, dealId?: string, party?: 'ALICE' | 'BOB'): Promise<EscrowAccountRef>;
  getManagedAddress(ref: EscrowAccountRef): Promise<string>;

  // Deposit monitoring
  listConfirmedDeposits(asset: AssetCode, address: string, minConf: number, since?: string): Promise<EscrowDepositsView>;

  // Pricing
  quoteNativeForUSD(usd: string): Promise<QuoteNativeForUSDResult>;

  // Transaction execution
  send(asset: AssetCode, from: EscrowAccountRef, to: string, amount: string): Promise<SubmittedTx>;

  // Utilities
  ensureFeeBudget(from: EscrowAccountRef, asset: AssetCode, intent: 'NATIVE'|'TOKEN', minNative: string): Promise<void>;
  getTxConfirmations(txid: string): Promise<number>;
  validateAddress(address: string): boolean;
  getOperatorAddress(): string;
}
```

### Plugin Hierarchy

```
ChainPlugin (interface)
    ├── UnicityPlugin (UTXO-based, WebSocket Electrum)
    └── EvmPlugin (EVM-based with ethers.js)
        ├── EthereumPlugin (extends EvmPlugin)
        │   ├── PolygonPlugin (extends EthereumPlugin)
        │   └── BasePlugin (extends EthereumPlugin)
        └── [Other EVM chains via config]
```

### Plugin Manager

The `PluginManager` class acts as a registry and factory for chain plugins:

- Instantiates appropriate plugin based on chain ID
- Maintains plugin instances throughout application lifecycle
- Provides plugin lookup by chain ID
- Passes database references for persistence

## Available Implementations

### 1. UnicityPlugin (UNICITY Chain)

**Type**: UTXO-based blockchain with SegWit support
**Protocol**: Electrum WebSocket (ElectrumX compatible)
**Key Features**:
- WebSocket-based communication with Electrum servers
- UTXO selection and transaction building
- SegWit P2WPKH address generation
- Automatic reconnection on network issues
- Multi-UTXO transaction batching for efficiency

**Configuration**:
```javascript
{
  chainId: 'UNICITY',
  electrumUrl: 'wss://electrum.unicity.io:50002',
  confirmations: 6,
  collectConfirms: 6,
  operator: { address: 'unicity1...' },
  hotWalletSeed: 'seed phrase or key'
}
```

### 2. EthereumPlugin (Ethereum Mainnet)

**Type**: EVM-compatible blockchain
**Protocol**: JSON-RPC via ethers.js
**Key Features**:
- Native ETH and ERC-20 token support
- HD wallet derivation (BIP-44 compatible)
- Gas estimation and management
- Etherscan API integration for transaction history
- Automatic gas funding for ERC-20 transfers (via TankManager)

**Configuration**:
```javascript
{
  chainId: 'ETH',
  rpcUrl: 'https://ethereum-rpc.publicnode.com',
  confirmations: 12,
  collectConfirms: 12,
  operator: { address: '0x...' },
  hotWalletSeed: 'seed phrase or key'
}
```

### 3. PolygonPlugin (Polygon PoS)

**Type**: EVM-compatible blockchain
**Protocol**: JSON-RPC via ethers.js
**Inheritance**: Extends EthereumPlugin with Polygon-specific defaults
**Key Features**:
- All EthereumPlugin features
- Higher confirmation requirements (30 blocks)
- MATIC native currency support
- Polygon-specific RPC endpoints

**Configuration**:
```javascript
{
  chainId: 'POLYGON',
  rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
  confirmations: 30,  // Higher due to reorg risk
  collectConfirms: 30,
  operator: { address: '0x...' },
  hotWalletSeed: 'seed phrase or key'
}
```

### 4. BasePlugin (Base L2)

**Type**: EVM-compatible Layer 2
**Protocol**: JSON-RPC via ethers.js
**Inheritance**: Extends EthereumPlugin with Base-specific defaults
**Key Features**:
- Optimistic rollup with faster finality
- Lower gas costs than Ethereum mainnet
- ETH as native currency

**Configuration**:
```javascript
{
  chainId: 'BASE',
  rpcUrl: 'https://base-rpc.publicnode.com',
  confirmations: 12,
  collectConfirms: 12,
  operator: { address: '0x...' },
  hotWalletSeed: 'seed phrase or key'
}
```

## How Plugins Interact with the Engine

### 1. Initialization Phase

During startup, the broker engine initializes plugins for each supported chain:

```typescript
const pluginManager = new PluginManager(database);

// Register each chain
await pluginManager.registerPlugin({
  chainId: 'UNICITY',
  electrumUrl: process.env.UNICITY_ELECTRUM,
  confirmations: 6,
  // ...
});

await pluginManager.registerPlugin({
  chainId: 'POLYGON',
  rpcUrl: process.env.POLYGON_RPC,
  confirmations: 30,
  // ...
});
```

### 2. Deal Creation (CREATED Stage)

When a deal is created, the engine uses plugins to generate deterministic escrow addresses:

```typescript
// For each party and asset
const aliceEscrow = await plugin.generateEscrowAccount(
  'USDT@POLYGON',
  dealId,
  'ALICE'
);

const bobEscrow = await plugin.generateEscrowAccount(
  'UNC@UNICITY',
  dealId,
  'BOB'
);
```

**Determinism**: Addresses are derived deterministically from:
- Hot wallet seed (master key)
- Deal ID
- Party (ALICE/BOB)
- Using BIP-32/44 HD derivation for EVM chains
- Using SHA256-based derivation for Unicity

### 3. Deposit Collection (COLLECTION Stage)

The engine periodically polls plugins to detect deposits:

```typescript
// Check for deposits with sufficient confirmations
const deposits = await plugin.listConfirmedDeposits(
  asset,
  escrowAddress,
  minConfirmations,
  since
);

// Deposits are considered "locked" when:
// 1. confirms >= collectConfirms (chain-specific finality)
// 2. blockTime <= deal.expiresAt
// 3. Total amount meets or exceeds expected
```

### 4. Distribution Planning (WAITING Stage)

Once deposits are locked, the engine plans distribution:

```typescript
// Calculate amounts including commission
const plan = computeDistributionPlan(deal, deposits);

// For each distribution
await plugin.send(
  asset,
  fromEscrow,
  toAddress,
  amount
);
```

### 5. Transaction Management

Plugins handle chain-specific transaction requirements:

**UTXO Chains (Unicity)**:
- Select appropriate UTXOs
- Build and sign SegWit transactions
- Batch multiple outputs in single transaction
- Manage change addresses

**Account-Based Chains (EVM)**:
- Manage account nonces sequentially
- Estimate and provide gas
- Handle ERC-20 token approvals
- Fund escrows with gas via TankManager

### 6. Confirmation Monitoring

The engine tracks transaction confirmations:

```typescript
const confirmations = await plugin.getTxConfirmations(txid);

if (confirmations === -1) {
  // Transaction was reorg'd - handle failure
} else if (confirmations >= requiredConfirms) {
  // Transaction is final
}
```

## Implementation Guide for New Chains

To add support for a new blockchain:

### 1. Choose Base Class

- **For EVM-compatible chains**: Extend `EthereumPlugin` or `EvmPlugin`
- **For UTXO-based chains**: Create new implementation of `ChainPlugin`
- **For account-based non-EVM**: Create new implementation of `ChainPlugin`

### 2. Implement Required Methods

```typescript
export class MyChainPlugin implements ChainPlugin {
  readonly chainId: ChainId = 'MYCHAIN';

  async init(cfg: ChainConfig): Promise<void> {
    // Initialize connection to blockchain
    // Set up wallet management
    // Configure network parameters
  }

  async generateEscrowAccount(...): Promise<EscrowAccountRef> {
    // Implement deterministic key derivation
    // Ensure uniqueness per deal/party
    // Return address and key reference
  }

  async listConfirmedDeposits(...): Promise<EscrowDepositsView> {
    // Query blockchain for incoming transactions
    // Filter by confirmation threshold
    // Return structured deposit list
  }

  // ... implement remaining interface methods
}
```

### 3. Handle Chain-Specific Requirements

**Asset Naming**: Support chain-specific asset codes:
- Native: `ETH`, `MATIC`, `BTC`, `UNC`
- Tokens: `ERC20:0x...`, `SPL:...`
- With chain suffix: `USDT@POLYGON`

**Confirmation Logic**: Set appropriate finality thresholds:
- Bitcoin: 6 confirmations
- Ethereum: 12 confirmations
- Polygon: 30 confirmations (higher reorg risk)
- Unicity: 6 confirmations

**Error Handling**: Implement robust error recovery:
- Network disconnections
- RPC rate limits
- Transaction failures
- Reorg detection

### 4. Register with PluginManager

Add plugin instantiation logic to `PluginManager.registerPlugin()`:

```typescript
case 'MYCHAIN':
  plugin = new MyChainPlugin();
  break;
```

### 5. Test Integration

Create comprehensive tests covering:
- Escrow generation determinism
- Deposit detection accuracy
- Transaction submission reliability
- Gas/fee estimation
- Error scenarios and recovery

## Security Considerations

### 1. Key Management

- **HD Derivation**: Uses BIP-32/44 standards for deterministic key generation
- **Isolation**: Each deal gets unique escrow addresses
- **No Key Reuse**: Addresses are never reused across deals
- **Secure Storage**: Private keys kept in memory only

### 2. Transaction Safety

- **Confirmation Thresholds**: Chain-specific finality requirements
- **Reorg Detection**: Returns -1 confirmations for reorg'd transactions
- **Atomic Operations**: All state changes in database transactions
- **Serial Submission**: Prevents nonce/UTXO conflicts

### 3. Amount Precision

- **No Floating Point**: All amounts as strings/BigInt
- **Decimal.js**: Used for precise arithmetic
- **Dust Handling**: Minimum amount thresholds per chain

## Utilities

### DealIndexDerivation

Converts deal IDs to HD wallet indices:
- SHA256 hash of `dealId + party`
- Modulo 1,000,000 for reasonable range
- Ensures Alice and Bob get different indices

### UnicityKeyManager

Manages Unicity-specific key operations:
- SegWit address generation
- Private key to WIF conversion
- Deterministic key derivation

### EtherscanAPI

Fetches transaction history from Etherscan:
- Incoming ETH transfers
- ERC-20 token transfers
- No API key required for basic queries

### UnicityTransaction

Builds and signs Unicity transactions:
- UTXO selection algorithms
- SegWit transaction construction
- Multi-output batching

## Future Enhancements

1. **Additional Chains**:
   - Solana (SPL tokens)
   - Bitcoin (Native BTC)
   - Arbitrum (L2)
   - Optimism (L2)

2. **Advanced Features**:
   - Hardware wallet support
   - Multi-signature escrows
   - Cross-chain atomic swaps
   - MEV protection for EVM chains

3. **Performance Optimizations**:
   - Connection pooling
   - Caching layer for deposit queries
   - Batch RPC requests
   - Event-based deposit detection

4. **Monitoring & Analytics**:
   - Plugin health metrics
   - Transaction success rates
   - Gas usage optimization
   - Network congestion detection

## Troubleshooting

### Common Issues

**"Plugin not registered for chain"**
- Ensure plugin is registered in PluginManager
- Check environment variables for chain configuration
- Verify chain ID matches expected format

**"Insufficient gas"**
- Check gas estimation in EVM plugins
- Ensure TankManager is configured for ERC-20
- Verify operator wallet has sufficient funds

**"Address collision detected"**
- Check for duplicate deal IDs
- Verify HD derivation indices
- Ensure proper database persistence

**"Transaction not found (-1 confirmations)"**
- Transaction was reorganized
- Check chain's reorg frequency
- Increase confirmation thresholds

## References

- [BIP-32: HD Wallets](https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki)
- [BIP-44: Multi-Account Hierarchy](https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki)
- [Electrum Protocol](https://electrumx-spesmilo.readthedocs.io/en/latest/protocol.html)
- [Ethers.js Documentation](https://docs.ethers.io/)
- [ERC-20 Token Standard](https://eips.ethereum.org/EIPS/eip-20)