/**
 * @fileoverview UTXO vesting status tracing for Unicity blockchain.
 * Traces UTXOs back to their coinbase origin to determine vesting status.
 *
 * VESTING RULES:
 * - Vested: Coinbase block height <= 280,000
 * - Unvested: Coinbase block height > 280,000
 *
 * The tracing algorithm follows the first input of each transaction
 * backwards until it reaches a coinbase transaction (mining reward).
 */

import { VestingStatus } from '@otc-broker/core';

/**
 * Block height threshold for vesting classification.
 * UTXOs from coinbase transactions at or before this block are "vested".
 */
export const VESTING_THRESHOLD_BLOCK = 280_000;

/**
 * Maximum number of transaction hops to trace before giving up.
 * This is a safety limit to prevent infinite loops.
 */
export const MAX_TRACE_DEPTH = 10_000;

/**
 * Result of tracing a UTXO to its coinbase origin.
 */
export interface VestingTraceResult {
  /** Vesting status based on coinbase origin */
  status: VestingStatus;
  /** Block height of the coinbase transaction (if found) */
  coinbaseBlockHeight?: number;
  /** Transaction ID of the coinbase transaction (if found) */
  coinbaseTxid?: string;
  /** Number of transaction hops traced */
  traceDepth: number;
  /** Error message if tracing failed */
  error?: string;
}

/**
 * Cached vesting entry for persistence.
 */
export interface VestingCacheEntry {
  txid: string;
  isCoinbase: boolean;
  coinbaseBlockHeight?: number;
  parentTxid?: string;
  vestingStatus: VestingStatus;
  tracedAt: string;
  errorMessage?: string;
}

/**
 * Interface for vesting cache persistence.
 */
export interface VestingCacheStore {
  get(txid: string): Promise<VestingCacheEntry | null>;
  set(entry: VestingCacheEntry): Promise<void>;
  setMultiple(entries: VestingCacheEntry[]): Promise<void>;
}

/**
 * Function type for making Electrum RPC requests.
 */
export type ElectrumRequestFn = (method: string, params: any[]) => Promise<any>;

/**
 * Traces Unicity UTXOs back to their coinbase origin to determine vesting status.
 * Uses both in-memory and optional persistent caching for efficiency.
 */
export class VestingTracer {
  private memoryCache = new Map<string, VestingCacheEntry>();
  private electrumRequest: ElectrumRequestFn;
  private persistentCache?: VestingCacheStore;

  /**
   * Creates a new VestingTracer.
   * @param electrumRequest - Function to make Electrum RPC calls
   * @param persistentCache - Optional persistent cache store (SQLite)
   */
  constructor(
    electrumRequest: ElectrumRequestFn,
    persistentCache?: VestingCacheStore
  ) {
    this.electrumRequest = electrumRequest;
    this.persistentCache = persistentCache;
  }

  /**
   * Classifies a UTXO's vesting status by tracing to its coinbase origin.
   * Results are cached for efficiency.
   *
   * @param txid - Transaction ID of the UTXO
   * @returns Vesting trace result with status and metadata
   */
  async classifyUtxo(txid: string): Promise<VestingTraceResult> {
    // Check memory cache first
    const memoryCached = this.memoryCache.get(txid);
    if (memoryCached && memoryCached.vestingStatus !== 'pending') {
      return {
        status: memoryCached.vestingStatus,
        coinbaseBlockHeight: memoryCached.coinbaseBlockHeight,
        traceDepth: 0,
      };
    }

    // Check persistent cache
    if (this.persistentCache) {
      const persistentCached = await this.persistentCache.get(txid);
      if (persistentCached && persistentCached.vestingStatus !== 'pending') {
        // Promote to memory cache
        this.memoryCache.set(txid, persistentCached);
        return {
          status: persistentCached.vestingStatus,
          coinbaseBlockHeight: persistentCached.coinbaseBlockHeight,
          traceDepth: 0,
        };
      }
    }

    // Trace to coinbase
    return this.traceToOrigin(txid);
  }

  /**
   * Traces a transaction back to its coinbase origin.
   * Uses iterative approach to avoid stack overflow on deep chains.
   *
   * @param txid - Starting transaction ID
   * @returns Trace result with vesting status
   */
  private async traceToOrigin(txid: string): Promise<VestingTraceResult> {
    let currentTxid = txid;
    let depth = 0;
    const tracePath: string[] = [];
    const traceEntries: VestingCacheEntry[] = [];

    while (depth < MAX_TRACE_DEPTH) {
      tracePath.push(currentTxid);
      depth++;

      // Check cache at each hop (might hit a previously traced chain)
      const cached = this.memoryCache.get(currentTxid);
      if (cached && cached.vestingStatus !== 'pending' && cached.coinbaseBlockHeight !== undefined) {
        // Found a cached result - propagate to entire path
        await this.propagateCoinbaseHeight(tracePath, cached.coinbaseBlockHeight, traceEntries);
        return {
          status: cached.vestingStatus,
          coinbaseBlockHeight: cached.coinbaseBlockHeight,
          coinbaseTxid: cached.isCoinbase ? currentTxid : undefined,
          traceDepth: depth,
        };
      }

      try {
        // Fetch transaction from Electrum
        const tx = await this.electrumRequest('blockchain.transaction.get', [currentTxid, true]);

        if (!tx) {
          return this.handleTracingError(tracePath, traceEntries, depth, `Transaction ${currentTxid} not found`);
        }

        // Check if this is a coinbase transaction
        if (this.isCoinbase(tx)) {
          // Try multiple field names for block height
          let blockHeight = tx.height || tx.blockheight || tx.block_height;

          // Fallback 1: Derive from confirmations + current chain height
          if (blockHeight === undefined && tx.confirmations !== undefined && tx.confirmations > 0) {
            try {
              const headersResult = await this.electrumRequest('blockchain.headers.subscribe', []);
              const currentHeight = headersResult?.height || headersResult?.block_height;
              if (currentHeight !== undefined) {
                blockHeight = currentHeight - tx.confirmations + 1;
                console.log(`[VestingTracer] Derived block height ${blockHeight} from confirmations (current: ${currentHeight}, confirms: ${tx.confirmations})`);
              }
            } catch (e) {
              console.warn(`[VestingTracer] Failed to get current height for fallback: ${e}`);
            }
          }

          // Fallback 2: Fetch block header by blockhash (if available)
          if (blockHeight === undefined && tx.blockhash) {
            try {
              // Try to get block header - some Electrum servers return height in header
              const blockHeader = await this.electrumRequest('blockchain.block.header', [tx.blockhash, 0]);
              if (typeof blockHeader === 'object' && blockHeader.height !== undefined) {
                blockHeight = blockHeader.height;
                console.log(`[VestingTracer] Got block height ${blockHeight} from block header`);
              }
            } catch (e) {
              console.warn(`[VestingTracer] Failed to fetch block header: ${e}`);
            }
          }

          // Fallback 3: Extract block height from coinbase field (BIP141 format)
          if (blockHeight === undefined && tx.vin && tx.vin[0] && tx.vin[0].coinbase) {
            try {
              const coinbaseHex = tx.vin[0].coinbase;
              const coinbaseBytes = Buffer.from(coinbaseHex, 'hex');

              if (coinbaseBytes.length > 0) {
                const heightLength = coinbaseBytes[0];
                if (heightLength > 0 && heightLength <= 9 && coinbaseBytes.length > heightLength) {
                  const heightBytes = coinbaseBytes.slice(1, 1 + heightLength);
                  // Convert from little-endian to big-endian integer
                  blockHeight = 0;
                  for (let i = 0; i < heightBytes.length; i++) {
                    blockHeight += heightBytes[i] * Math.pow(256, i);
                  }
                  console.log(`[VestingTracer] Extracted block height ${blockHeight} from coinbase field`);
                }
              }
            } catch (e) {
              console.warn(`[VestingTracer] Failed to extract block height from coinbase field: ${e}`);
            }
          }

          if (blockHeight === undefined) {
            // Log available fields for debugging
            console.error(`[VestingTracer] Coinbase ${currentTxid} - available fields:`, {
              height: tx.height,
              blockheight: tx.blockheight,
              block_height: tx.block_height,
              confirmations: tx.confirmations,
              blockhash: tx.blockhash
            });
            return this.handleTracingError(tracePath, traceEntries, depth, `Coinbase ${currentTxid} has no block height (tried all methods)`);
          }

          const status = this.getVestingStatusFromHeight(blockHeight);

          // Cache the coinbase entry
          const coinbaseEntry: VestingCacheEntry = {
            txid: currentTxid,
            isCoinbase: true,
            coinbaseBlockHeight: blockHeight,
            vestingStatus: status,
            tracedAt: new Date().toISOString(),
          };
          traceEntries.push(coinbaseEntry);

          // Propagate result to entire trace path
          await this.propagateCoinbaseHeight(tracePath, blockHeight, traceEntries);

          return {
            status,
            coinbaseBlockHeight: blockHeight,
            coinbaseTxid: currentTxid,
            traceDepth: depth,
          };
        }

        // Not a coinbase - check if we can follow the chain
        if (!tx.vin || tx.vin.length === 0) {
          return this.handleTracingError(tracePath, traceEntries, depth, `Transaction ${currentTxid} has no inputs`);
        }

        // Check for unconfirmed parent
        if (!tx.confirmations || tx.confirmations < 1) {
          return {
            status: 'unknown',
            traceDepth: depth,
            error: `Unconfirmed transaction in chain at ${currentTxid}`,
          };
        }

        const firstInput = tx.vin[0];

        // Get parent txid from input
        if (!firstInput.txid || firstInput.txid === '0'.repeat(64)) {
          // This looks like a coinbase that we didn't detect properly
          return this.handleTracingError(tracePath, traceEntries, depth, `Input has null/zero txid at ${currentTxid}`);
        }

        // Cache intermediate entry
        const intermediateEntry: VestingCacheEntry = {
          txid: currentTxid,
          isCoinbase: false,
          parentTxid: firstInput.txid,
          vestingStatus: 'pending',
          tracedAt: new Date().toISOString(),
        };
        traceEntries.push(intermediateEntry);
        this.memoryCache.set(currentTxid, intermediateEntry);

        // Move to parent transaction
        currentTxid = firstInput.txid;

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return this.handleTracingError(tracePath, traceEntries, depth, `Network error: ${errorMsg}`);
      }
    }

    // Max depth exceeded
    return this.handleTracingError(tracePath, traceEntries, depth, `Max trace depth (${MAX_TRACE_DEPTH}) exceeded`);
  }

  /**
   * Checks if a transaction is a coinbase (mining reward) transaction.
   */
  private isCoinbase(tx: any): boolean {
    if (!tx.vin || tx.vin.length === 0) return false;

    const firstInput = tx.vin[0];

    // Coinbase transactions have a 'coinbase' field in their input
    if (firstInput.coinbase !== undefined) return true;

    // Or the txid is all zeros
    if (firstInput.txid === '0'.repeat(64)) return true;

    // Or there's no txid at all
    if (!firstInput.txid) return true;

    return false;
  }

  /**
   * Determines vesting status from coinbase block height.
   */
  private getVestingStatusFromHeight(blockHeight: number): 'vested' | 'unvested' {
    return blockHeight <= VESTING_THRESHOLD_BLOCK ? 'vested' : 'unvested';
  }

  /**
   * Propagates coinbase height to all entries in the trace path.
   */
  private async propagateCoinbaseHeight(
    tracePath: string[],
    coinbaseHeight: number,
    traceEntries: VestingCacheEntry[]
  ): Promise<void> {
    const status = this.getVestingStatusFromHeight(coinbaseHeight);

    // Update all entries with the final result
    for (const entry of traceEntries) {
      entry.coinbaseBlockHeight = coinbaseHeight;
      entry.vestingStatus = status;
      this.memoryCache.set(entry.txid, entry);
    }

    // Also update any txids in path not yet in entries
    for (const txid of tracePath) {
      if (!traceEntries.find(e => e.txid === txid)) {
        const entry: VestingCacheEntry = {
          txid,
          isCoinbase: false,
          coinbaseBlockHeight: coinbaseHeight,
          vestingStatus: status,
          tracedAt: new Date().toISOString(),
        };
        traceEntries.push(entry);
        this.memoryCache.set(txid, entry);
      }
    }

    // Persist to database if available
    if (this.persistentCache && traceEntries.length > 0) {
      await this.persistentCache.setMultiple(traceEntries);
    }

    // Limit memory cache size
    this.pruneMemoryCache();
  }

  /**
   * Handles tracing errors by caching the failure.
   * Only persists PERMANENT failures to database - transient errors are memory-only
   * to allow retry on next classification attempt.
   */
  private async handleTracingError(
    tracePath: string[],
    traceEntries: VestingCacheEntry[],
    depth: number,
    error: string
  ): Promise<VestingTraceResult> {
    console.error(`[VestingTracer] Tracing failed: ${error}`);

    // Determine if this is a permanent failure (shouldn't retry)
    const isPermanentFailure =
      error.includes('Max trace depth') ||
      error.includes('has no inputs') ||
      error.includes('null/zero txid') ||
      (error.includes('Transaction') && error.includes('not found'));

    // Mark all entries as failed in memory cache
    for (const entry of traceEntries) {
      entry.vestingStatus = 'tracing_failed';
      entry.errorMessage = error;
      this.memoryCache.set(entry.txid, entry);
    }

    // Only persist PERMANENT failures to database (allow retry for transient)
    if (isPermanentFailure && this.persistentCache && traceEntries.length > 0) {
      console.log(`[VestingTracer] Persisting permanent failure to database: ${error}`);
      await this.persistentCache.setMultiple(traceEntries);
    } else if (!isPermanentFailure) {
      console.log(`[VestingTracer] Transient failure - NOT persisting to database (will retry): ${error}`);
    }

    return {
      status: 'tracing_failed',
      traceDepth: depth,
      error,
    };
  }

  /**
   * Limits memory cache size to prevent unbounded growth.
   */
  private pruneMemoryCache(): void {
    const MAX_CACHE_SIZE = 50_000;

    if (this.memoryCache.size > MAX_CACHE_SIZE) {
      // Remove oldest entries (first 10%)
      const entriesToRemove = Math.floor(MAX_CACHE_SIZE * 0.1);
      const iterator = this.memoryCache.keys();

      for (let i = 0; i < entriesToRemove; i++) {
        const result = iterator.next();
        if (result.done) break;
        this.memoryCache.delete(result.value);
      }
    }
  }

  /**
   * Clears the in-memory cache.
   */
  clearMemoryCache(): void {
    this.memoryCache.clear();
  }

  /**
   * Gets cache statistics for debugging.
   */
  getCacheStats(): { memoryCacheSize: number } {
    return {
      memoryCacheSize: this.memoryCache.size,
    };
  }
}
