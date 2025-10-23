# ERC20 Transfer Parsing - Method Signatures and Implementation Guide

## Overview

This document provides detailed method signatures, interfaces, and pseudocode for implementing ERC20 transfer parsing from broker contract transactions.

## Core Interfaces and Types

### TypeScript Type Definitions

```typescript
/**
 * Represents a single ERC20 Transfer event from transaction logs.
 * Used to track token movements in broker contract operations.
 */
export interface ERC20TransferEvent {
  /** Transfer sender address (typically escrow for broker operations) */
  from: string;

  /** Transfer recipient address */
  to: string;

  /** Formatted token amount (e.g., "1000.5" for 1000.5 USDT) */
  value: string;

  /** Classification of transfer purpose */
  type: 'swap' | 'fee' | 'refund' | 'unknown';

  /** Position in transaction logs (for ordering) */
  logIndex: number;

  /** ERC20 token contract address */
  tokenAddress: string;

  /** Token decimals used for formatting */
  decimals: number;

  /** Block number containing this transfer */
  blockNumber?: number;

  /** Transaction hash */
  txHash: string;
}

/**
 * Raw log data structure from Etherscan or RPC node.
 */
export interface RawTransferLog {
  address: string;           // Token contract address
  topics: string[];          // [eventSig, from, to]
  data: string;              // Hex-encoded value
  logIndex: string | number; // Position in logs
  blockNumber: string | number;
  transactionHash: string;
  timeStamp?: string;
}

/**
 * Constants for ERC20 event parsing.
 */
export const ERC20_CONSTANTS = {
  /** ERC20 Transfer event signature: keccak256("Transfer(address,address,uint256)") */
  TRANSFER_EVENT_TOPIC: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',

  /** Known token addresses for validation */
  KNOWN_TOKENS: {
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
  } as Record<string, Record<string, string>>
} as const;
```

## Method Signatures

### 1. EthereumPlugin.getERC20Transfers()

**Primary method for fetching and classifying ERC20 transfers from broker transactions.**

```typescript
/**
 * Fetch and decode ERC20 Transfer events from a broker contract transaction.
 * Parses Transfer events to identify swap payouts, commission payments, and refunds.
 *
 * Uses Etherscan API as primary data source with RPC node fallback.
 * Automatically classifies transfers based on their position and patterns.
 *
 * @param txHash - Transaction hash to fetch ERC20 transfers for
 * @param tokenAddress - ERC20 token contract address to filter transfers
 * @param escrowAddress - Optional escrow address to filter FROM transfers (if known)
 * @returns Array of decoded ERC20 transfers with type classification
 *
 * @example
 * ```typescript
 * const transfers = await plugin.getERC20Transfers(
 *   '0xabc123...',
 *   '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
 *   '0xescrow...'
 * );
 * // Returns:
 * // [
 * //   { from: '0xescrow...', to: '0xbob...', value: '1000.0', type: 'swap', logIndex: 5 },
 * //   { from: '0xescrow...', to: '0xop...', value: '3.0', type: 'fee', logIndex: 6 },
 * //   { from: '0xescrow...', to: '0xalice...', value: '97.0', type: 'refund', logIndex: 7 }
 * // ]
 * ```
 */
async getERC20Transfers(
  txHash: string,
  tokenAddress: string,
  escrowAddress?: string
): Promise<ERC20TransferEvent[]>
```

### 2. EtherscanAPI.getERC20TransfersByTxHash()

**Etherscan-specific method for fetching Transfer event logs.**

```typescript
/**
 * Fetch ERC20 Transfer events for a specific transaction from Etherscan.
 * Uses the getLogs API endpoint to retrieve Transfer events.
 *
 * @param txHash - Transaction hash
 * @param tokenAddress - ERC20 token contract address
 * @returns Array of raw transfer logs from Etherscan
 *
 * @throws Error if API key is required but not provided
 * @throws Error if API rate limit exceeded
 */
async getERC20TransfersByTxHash(
  txHash: string,
  tokenAddress: string
): Promise<RawTransferLog[]>
```

### 3. Helper Functions

```typescript
/**
 * Parse raw transfer logs into structured transfer events.
 *
 * @param logs - Raw logs from Etherscan or RPC node
 * @param tokenAddress - Token contract address for validation
 * @param decimals - Token decimals for amount formatting
 * @returns Parsed transfer events without classification
 */
function parseTransferLogs(
  logs: RawTransferLog[],
  tokenAddress: string,
  decimals: number
): Array<Omit<ERC20TransferEvent, 'type'>>

/**
 * Classify ERC20 transfers based on broker contract patterns.
 * Determines if each transfer is a swap, fee, or refund based on position.
 *
 * @param transfers - Parsed transfers (without type classification)
 * @param escrowAddress - Escrow address to filter FROM transfers
 * @returns Transfers with type classification
 */
function classifyERC20Transfers(
  transfers: Array<Omit<ERC20TransferEvent, 'type'>>,
  escrowAddress: string
): ERC20TransferEvent[]

/**
 * Decode ERC20 Transfer event log data.
 *
 * @param topics - Event topics [eventSig, from, to]
 * @param data - Hex-encoded value data
 * @returns Decoded from/to/value
 */
function decodeTransferLog(
  topics: string[],
  data: string
): { from: string; to: string; value: bigint }

/**
 * Format token amount from raw value using decimals.
 *
 * @param value - Raw token value (bigint)
 * @param decimals - Token decimals
 * @returns Formatted amount string (e.g., "1000.5")
 */
function formatTokenAmount(value: bigint, decimals: number): string
```

## Implementation Pseudocode

### getERC20Transfers() Implementation

```typescript
async getERC20Transfers(
  txHash: string,
  tokenAddress: string,
  escrowAddress?: string
): Promise<ERC20TransferEvent[]> {
  console.log(`[${this.chainId}] Fetching ERC20 transfers for ${txHash}, token: ${tokenAddress}`);

  // Step 1: Normalize addresses
  tokenAddress = tokenAddress.toLowerCase();
  if (escrowAddress) {
    escrowAddress = escrowAddress.toLowerCase();
  }

  let rawLogs: RawTransferLog[] = [];
  let decimals = 18; // Default

  // Step 2: Try Etherscan API first (if available)
  if (this.etherscanAPI) {
    try {
      console.log(`[${this.chainId}] Attempting Etherscan API...`);
      rawLogs = await this.etherscanAPI.getERC20TransfersByTxHash(txHash, tokenAddress);
      console.log(`[${this.chainId}] Etherscan returned ${rawLogs.length} transfer logs`);
    } catch (error) {
      console.warn(`[${this.chainId}] Etherscan API failed:`, error);
      // Fall through to RPC fallback
    }
  }

  // Step 3: Fallback to RPC node if Etherscan failed or unavailable
  if (rawLogs.length === 0) {
    try {
      console.log(`[${this.chainId}] Attempting RPC node fallback...`);
      const receipt = await this.provider.getTransactionReceipt(txHash);

      if (!receipt) {
        console.warn(`[${this.chainId}] Transaction not found: ${txHash}`);
        return [];
      }

      if (receipt.status === 0) {
        console.warn(`[${this.chainId}] Transaction failed (status=0): ${txHash}`);
        return [];
      }

      // Filter logs for Transfer events from the specific token
      rawLogs = receipt.logs
        .filter(log =>
          log.address.toLowerCase() === tokenAddress &&
          log.topics[0] === ERC20_CONSTANTS.TRANSFER_EVENT_TOPIC
        )
        .map(log => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
          logIndex: log.index,
          blockNumber: receipt.blockNumber,
          transactionHash: log.transactionHash
        }));

      console.log(`[${this.chainId}] RPC node returned ${rawLogs.length} transfer logs`);
    } catch (error) {
      console.error(`[${this.chainId}] RPC fallback failed:`, error);
      return [];
    }
  }

  if (rawLogs.length === 0) {
    console.log(`[${this.chainId}] No ERC20 transfers found for ${txHash}`);
    return [];
  }

  // Step 4: Get token decimals for formatting
  try {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    decimals = await tokenContract.decimals();
    console.log(`[${this.chainId}] Token decimals: ${decimals}`);
  } catch (error) {
    console.warn(`[${this.chainId}] Could not get token decimals, using default 18:`, error);
  }

  // Step 5: Parse raw logs into structured transfers
  const parsedTransfers = parseTransferLogs(rawLogs, tokenAddress, decimals);

  // Step 6: Classify transfers if escrow address is known
  if (escrowAddress) {
    const classifiedTransfers = classifyERC20Transfers(parsedTransfers, escrowAddress);
    console.log(`[${this.chainId}] Classified ${classifiedTransfers.length} transfers`);
    return classifiedTransfers;
  }

  // Step 7: Return unclassified transfers if no escrow filter
  console.log(`[${this.chainId}] Returning ${parsedTransfers.length} unclassified transfers`);
  return parsedTransfers.map(t => ({ ...t, type: 'unknown' as const }));
}
```

### parseTransferLogs() Implementation

```typescript
function parseTransferLogs(
  logs: RawTransferLog[],
  tokenAddress: string,
  decimals: number
): Array<Omit<ERC20TransferEvent, 'type'>> {
  return logs.map(log => {
    // Decode from/to/value from topics and data
    const { from, to, value } = decodeTransferLog(log.topics, log.data);

    // Format amount using token decimals
    const formattedValue = formatTokenAmount(value, decimals);

    return {
      from,
      to,
      value: formattedValue,
      logIndex: typeof log.logIndex === 'string' ? parseInt(log.logIndex, 16) : log.logIndex,
      tokenAddress: tokenAddress.toLowerCase(),
      decimals,
      blockNumber: typeof log.blockNumber === 'string' ? parseInt(log.blockNumber, 16) : log.blockNumber,
      txHash: log.transactionHash
    };
  });
}
```

### classifyERC20Transfers() Implementation

```typescript
function classifyERC20Transfers(
  transfers: Array<Omit<ERC20TransferEvent, 'type'>>,
  escrowAddress: string
): ERC20TransferEvent[] {
  // Filter: Only transfers FROM escrow (ignore incoming deposits)
  const escrowTransfers = transfers.filter(
    t => t.from.toLowerCase() === escrowAddress.toLowerCase()
  );

  // Sort by log index (execution order)
  escrowTransfers.sort((a, b) => a.logIndex - b.logIndex);

  console.log(`Classifying ${escrowTransfers.length} escrow transfers`);

  // Classify based on count and position
  return escrowTransfers.map((transfer, index) => {
    let type: 'swap' | 'fee' | 'refund' | 'unknown';

    if (escrowTransfers.length === 1) {
      // Single transfer: refund-only (no fees, or swap-only with no fees/surplus)
      type = 'refund';
    } else if (escrowTransfers.length === 2) {
      // Two transfers:
      // - Pattern A: fee + refund (revert/refund operations)
      // - Pattern B: swap + fee (successful swap with no surplus)
      // Default to fee + refund pattern for consistency
      if (index === 0) {
        type = 'fee';
      } else {
        type = 'refund';
      }
    } else if (escrowTransfers.length >= 3) {
      // Three or more transfers: swap + fee + refund (standard swap with surplus)
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

    return {
      ...transfer,
      type
    };
  });
}
```

### decodeTransferLog() Implementation

```typescript
function decodeTransferLog(
  topics: string[],
  data: string
): { from: string; to: string; value: bigint } {
  if (topics.length < 3) {
    throw new Error('Invalid Transfer event: insufficient topics');
  }

  // Topic 0 = event signature (already filtered)
  // Topic 1 = from address (indexed, padded to 32 bytes)
  // Topic 2 = to address (indexed, padded to 32 bytes)
  // Data = value (uint256, 32 bytes)

  // Extract addresses from topics (remove padding)
  const from = ethers.getAddress('0x' + topics[1].slice(26));
  const to = ethers.getAddress('0x' + topics[2].slice(26));

  // Decode value from data
  const value = BigInt(data);

  return { from, to, value };
}
```

### formatTokenAmount() Implementation

```typescript
function formatTokenAmount(value: bigint, decimals: number): string {
  // Use ethers.js formatUnits for consistent formatting
  return ethers.formatUnits(value, decimals);
}
```

## EtherscanAPI Extension

### getERC20TransfersByTxHash() Implementation

Add to `/home/vrogojin/otc_agent/packages/chains/src/utils/EtherscanAPI.ts`:

```typescript
/**
 * Fetch ERC20 Transfer events for a specific transaction.
 * Uses Etherscan's getLogs API endpoint.
 *
 * @param txHash - Transaction hash
 * @param tokenAddress - ERC20 token contract address
 * @returns Array of raw transfer logs
 */
async getERC20TransfersByTxHash(
  txHash: string,
  tokenAddress: string
): Promise<RawTransferLog[]> {
  try {
    const params = new URLSearchParams({
      module: 'logs',
      action: 'getLogs',
      address: tokenAddress,
      topic0: ERC20_CONSTANTS.TRANSFER_EVENT_TOPIC,
      txhash: txHash
    });

    // Add API key if available
    if (this.apiKey) {
      params.append('apikey', this.apiKey);
    }

    const response = await fetch(`${this.apiUrl}?${params.toString()}`);
    const data = await response.json();

    // Check for API errors
    if (data.message && data.message.includes('deprecated V1 endpoint')) {
      console.error(`Etherscan API error: ${data.message}. API key required for V2.`);
      if (!this.apiKey) {
        console.error(`Please set API key environment variable for ${this.apiUrl}`);
      }
      return [];
    }

    if (data.status === '1' && Array.isArray(data.result)) {
      return data.result as RawTransferLog[];
    } else if (data.message === 'No records found') {
      return [];
    } else {
      console.warn('Etherscan API response for ERC20 transfers:', data.message);
      return [];
    }
  } catch (error) {
    console.error('Failed to fetch ERC20 transfers from Etherscan:', error);
    throw error;
  }
}
```

## Engine Integration

### Location: `packages/backend/src/engine/Engine.ts`

```typescript
/**
 * Process completed broker transaction and extract ERC20 transfers.
 * Called after a BROKER_SWAP, BROKER_REVERT, or BROKER_REFUND transaction confirms.
 */
async processCompletedBrokerTransaction(
  deal: Deal,
  queueItem: QueueItem
): Promise<void> {
  // Only process broker-related queue items
  if (!['BROKER_SWAP', 'BROKER_REVERT', 'BROKER_REFUND'].includes(queueItem.purpose)) {
    return;
  }

  // Skip if no transaction hash
  if (!queueItem.submittedTx?.txid) {
    return;
  }

  // Skip native currency operations (use internal transactions instead)
  if (queueItem.asset === this.chainId || queueItem.asset === `${this.chainId}@${this.chainId}`) {
    console.log(`[Engine] Skipping ERC20 parsing for native currency: ${queueItem.asset}`);
    return;
  }

  // Extract token address from asset code
  const tokenAddress = extractTokenAddress(queueItem.asset);
  if (!tokenAddress) {
    console.warn(`[Engine] Could not extract token address from asset: ${queueItem.asset}`);
    return;
  }

  // Get chain plugin
  const plugin = await this.chains.getPlugin(queueItem.chainId);
  if (!plugin.getERC20Transfers) {
    console.warn(`[Engine] Chain plugin ${queueItem.chainId} does not support ERC20 transfer parsing`);
    return;
  }

  try {
    console.log(`[Engine] Fetching ERC20 transfers for ${queueItem.submittedTx.txid}`);

    // Fetch ERC20 transfers
    const transfers = await plugin.getERC20Transfers(
      queueItem.submittedTx.txid,
      tokenAddress,
      queueItem.from.address  // Filter by escrow address
    );

    console.log(`[Engine] Found ${transfers.length} ERC20 transfers:`, transfers);

    // Store transfers in queue item
    queueItem.erc20Transfers = transfers.map(t => ({
      to: t.to,
      value: t.value,
      type: t.type as 'swap' | 'fee' | 'refund'
    }));

    // Log transfers in deal events for audit trail
    deal.events.push({
      t: new Date().toISOString(),
      msg: `ERC20 transfers parsed for ${queueItem.purpose}: ${transfers.map(t => `${t.type}(${t.value} to ${t.to.slice(0, 10)}...)`).join(', ')}`
    });

    // Persist updated queue item and deal
    await this.database.updateQueueItem(queueItem);
    await this.database.updateDeal(deal);

  } catch (error) {
    console.error(`[Engine] Failed to fetch ERC20 transfers for ${queueItem.submittedTx.txid}:`, error);
    // Don't throw - transfer parsing is nice-to-have, not critical
  }
}

/**
 * Helper: Extract token address from asset code.
 *
 * @param asset - Asset code (e.g., "ERC20:0xabc...", "0xabc123@ETH", "USDT@ETH")
 * @returns Token contract address or null if not found
 */
function extractTokenAddress(asset: AssetCode): string | null {
  // Handle direct token addresses (e.g., "0xabc123...")
  if (asset.startsWith('0x')) {
    return asset.split('@')[0];
  }

  // Handle ERC20: prefix (e.g., "ERC20:0xabc...")
  if (asset.startsWith('ERC20:')) {
    return asset.split(':')[1].split('@')[0];
  }

  // Handle known token symbols (e.g., "USDT@ETH")
  const [symbol, chain] = asset.split('@');
  const knownTokens = ERC20_CONSTANTS.KNOWN_TOKENS[chain || this.chainId];
  if (knownTokens && knownTokens[symbol]) {
    return knownTokens[symbol];
  }

  return null;
}
```

## Queue Processor Integration

### Location: `packages/backend/src/engine/QueueProcessor.ts`

```typescript
/**
 * After processing a queue item that confirms, parse ERC20 transfers if applicable.
 */
async afterQueueItemConfirmed(deal: Deal, queueItem: QueueItem): Promise<void> {
  // Parse ERC20 transfers for broker operations
  if (['BROKER_SWAP', 'BROKER_REVERT', 'BROKER_REFUND'].includes(queueItem.purpose)) {
    await this.processCompletedBrokerTransaction(deal, queueItem);
  }
}
```

## API Response Extension

### Location: `packages/backend/src/api/rpc-server.ts`

```typescript
/**
 * Extend otc.status response to include ERC20 transfer details.
 */
interface DealStatusResponse {
  // ... existing fields

  /**
   * Parsed ERC20 transfers from broker transactions.
   * Grouped by transaction hash for easy lookup.
   */
  erc20Transfers?: Record<string, Array<{
    to: string;
    value: string;
    type: 'swap' | 'fee' | 'refund';
  }>>;
}

// In status handler:
const erc20Transfers: Record<string, any[]> = {};

for (const queueItem of deal.outQueue) {
  if (queueItem.erc20Transfers && queueItem.submittedTx?.txid) {
    erc20Transfers[queueItem.submittedTx.txid] = queueItem.erc20Transfers;
  }
}

for (const queueItem of deal.refundQueue) {
  if (queueItem.erc20Transfers && queueItem.submittedTx?.txid) {
    erc20Transfers[queueItem.submittedTx.txid] = queueItem.erc20Transfers;
  }
}

return {
  // ... existing response fields
  erc20Transfers: Object.keys(erc20Transfers).length > 0 ? erc20Transfers : undefined
};
```

## Testing Strategy

### Unit Tests

```typescript
describe('ERC20 Transfer Parsing', () => {
  describe('parseTransferLogs', () => {
    it('should parse raw transfer logs correctly', () => {
      const rawLogs = [
        {
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          topics: [
            ERC20_CONSTANTS.TRANSFER_EVENT_TOPIC,
            '0x000000000000000000000000' + 'escrow'.padStart(40, '0'),
            '0x000000000000000000000000' + 'recipient'.padStart(40, '0')
          ],
          data: '0x' + (1000000000).toString(16).padStart(64, '0'),
          logIndex: 5,
          blockNumber: 12345678,
          transactionHash: '0xabc...'
        }
      ];

      const transfers = parseTransferLogs(rawLogs, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6);
      expect(transfers).toHaveLength(1);
      expect(transfers[0].value).toBe('1000.0');
      expect(transfers[0].decimals).toBe(6);
    });
  });

  describe('classifyERC20Transfers', () => {
    it('should classify 3 transfers as swap/fee/refund', () => {
      const transfers = [
        { from: '0xescrow', to: '0xrecipient', value: '1000', logIndex: 5 },
        { from: '0xescrow', to: '0xoperator', value: '3', logIndex: 6 },
        { from: '0xescrow', to: '0xpayback', value: '97', logIndex: 7 }
      ];

      const classified = classifyERC20Transfers(transfers as any, '0xescrow');
      expect(classified[0].type).toBe('swap');
      expect(classified[1].type).toBe('fee');
      expect(classified[2].type).toBe('refund');
    });

    it('should classify 2 transfers as fee/refund', () => {
      const transfers = [
        { from: '0xescrow', to: '0xoperator', value: '3', logIndex: 3 },
        { from: '0xescrow', to: '0xpayback', value: '1097', logIndex: 4 }
      ];

      const classified = classifyERC20Transfers(transfers as any, '0xescrow');
      expect(classified[0].type).toBe('fee');
      expect(classified[1].type).toBe('refund');
    });

    it('should filter out non-escrow transfers', () => {
      const transfers = [
        { from: '0xother', to: '0xrecipient', value: '1000', logIndex: 4 },
        { from: '0xescrow', to: '0xoperator', value: '3', logIndex: 5 }
      ];

      const classified = classifyERC20Transfers(transfers as any, '0xescrow');
      expect(classified).toHaveLength(1);
      expect(classified[0].from).toBe('0xescrow');
    });
  });
});
```

### Integration Tests

```typescript
describe('EthereumPlugin.getERC20Transfers', () => {
  it('should fetch transfers from Etherscan API', async () => {
    const plugin = new EthereumPlugin({ chainId: 'ETH' });
    await plugin.init({
      chainId: 'ETH',
      rpcUrl: process.env.ETH_RPC,
      etherscanApiKey: process.env.ETHERSCAN_API_KEY,
      // ... other config
    });

    const transfers = await plugin.getERC20Transfers(
      '0xabc...', // Real transaction hash
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
      '0xescrow...'
    );

    expect(transfers).toBeInstanceOf(Array);
    expect(transfers.length).toBeGreaterThan(0);
    expect(transfers[0]).toHaveProperty('type');
    expect(transfers[0]).toHaveProperty('value');
  });

  it('should fallback to RPC if Etherscan fails', async () => {
    // Test without API key
    const plugin = new EthereumPlugin({ chainId: 'ETH' });
    await plugin.init({
      chainId: 'ETH',
      rpcUrl: process.env.ETH_RPC,
      // No Etherscan API key
    });

    const transfers = await plugin.getERC20Transfers(
      '0xabc...', // Real transaction hash
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' // USDC
    );

    expect(transfers).toBeInstanceOf(Array);
  });
});
```

## Error Scenarios and Handling

### Scenario 1: Transaction Not Found

```typescript
// getERC20Transfers() should return empty array
const transfers = await plugin.getERC20Transfers(
  '0xnonexistent...',
  '0xtoken...'
);
expect(transfers).toEqual([]);
```

### Scenario 2: Failed Transaction

```typescript
// Should detect receipt.status === 0 and return empty array
const transfers = await plugin.getERC20Transfers(
  '0xfailedtx...',
  '0xtoken...'
);
expect(transfers).toEqual([]);
```

### Scenario 3: No Transfers in Transaction

```typescript
// Should return empty array if no Transfer events found
const transfers = await plugin.getERC20Transfers(
  '0xtxwithouttransfers...',
  '0xtoken...'
);
expect(transfers).toEqual([]);
```

### Scenario 4: Multiple Token Transfers

```typescript
// Should only return transfers for specified token
const transfers = await plugin.getERC20Transfers(
  '0xtxwithmultipletokens...',
  '0xusdc...'  // Should filter out USDT transfers
);
expect(transfers.every(t => t.tokenAddress.toLowerCase() === '0xusdc...')).toBe(true);
```

## Performance Considerations

### Caching Strategy

```typescript
// Cache ERC20 transfers in memory to avoid repeated API calls
const transferCache = new Map<string, ERC20TransferEvent[]>();

async function getCachedERC20Transfers(
  txHash: string,
  tokenAddress: string,
  escrowAddress?: string
): Promise<ERC20TransferEvent[]> {
  const cacheKey = `${txHash}:${tokenAddress}:${escrowAddress || 'all'}`;

  if (transferCache.has(cacheKey)) {
    console.log(`[Cache] Hit for ${cacheKey}`);
    return transferCache.get(cacheKey)!;
  }

  console.log(`[Cache] Miss for ${cacheKey}, fetching...`);
  const transfers = await plugin.getERC20Transfers(txHash, tokenAddress, escrowAddress);

  transferCache.set(cacheKey, transfers);
  return transfers;
}
```

### Rate Limiting for Etherscan

```typescript
// Simple rate limiter for Etherscan API
class RateLimiter {
  private lastCall = 0;
  private minInterval = 200; // 5 calls per second

  async waitIfNeeded(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCall;

    if (elapsed < this.minInterval) {
      const waitTime = this.minInterval - elapsed;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastCall = Date.now();
  }
}

const rateLimiter = new RateLimiter();

// Use before API calls:
await rateLimiter.waitIfNeeded();
const logs = await etherscanAPI.getERC20TransfersByTxHash(txHash, tokenAddress);
```
