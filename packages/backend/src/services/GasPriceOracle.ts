import { ChainId } from '@otc-broker/core';
import { ethers } from 'ethers';

/**
 * Gas price data with EIP-1559 support
 */
export interface GasPriceData {
  gasPrice: bigint;           // Legacy gas price (pre-EIP-1559)
  maxFeePerGas: bigint;       // EIP-1559 max fee per gas
  maxPriorityFeePerGas: bigint; // EIP-1559 priority fee
  timestamp: number;          // When this data was fetched
  source: 'live' | 'cache' | 'fallback'; // Data source
}

/**
 * Cached gas price entry
 */
interface CacheEntry {
  data: GasPriceData;
  timestamp: number;
}

/**
 * Gas Price Oracle with caching and circuit breakers
 *
 * Responsibilities:
 * - Query live gas prices from EVM providers
 * - Cache prices to reduce RPC calls (12-second TTL = 1 Ethereum block)
 * - Provide circuit breakers for extreme gas prices
 * - Support both legacy and EIP-1559 pricing
 * - Integrate with Polygon Gas Station API
 */
export class GasPriceOracle {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL_MS: number;
  private readonly maxGasPrices: Record<string, bigint>;

  constructor(
    cacheTtlMs: number = 12000, // 12 seconds (1 Ethereum block)
    maxGasPrices?: Partial<Record<ChainId, string>> // in gwei
  ) {
    this.CACHE_TTL_MS = cacheTtlMs;

    // Circuit breaker: Maximum acceptable gas prices per chain (in wei)
    this.maxGasPrices = {
      'ETH': ethers.parseUnits(maxGasPrices?.ETH || '500', 'gwei'),
      'SEPOLIA': ethers.parseUnits(maxGasPrices?.SEPOLIA || '1000', 'gwei'), // Testnet
      'POLYGON': ethers.parseUnits(maxGasPrices?.POLYGON || '2000', 'gwei'), // Higher volatility
      'BASE': ethers.parseUnits(maxGasPrices?.BASE || '100', 'gwei'), // L2
      'BSC': ethers.parseUnits(maxGasPrices?.BSC || '100', 'gwei'),
    };
  }

  /**
   * Get gas price for a chain, using cache if available
   */
  async getGasPrice(
    chainId: ChainId,
    provider: ethers.Provider,
    bypassCache: boolean = false
  ): Promise<GasPriceData> {
    const cacheKey = chainId;

    // Check cache first (unless bypassed)
    if (!bypassCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        console.log(`[GasPriceOracle] Using cached gas price for ${chainId} (age: ${Math.floor((Date.now() - cached.timestamp) / 1000)}s)`);
        return { ...cached.data, source: 'cache' };
      }
    }

    // Fetch live gas price
    const liveData = await this.fetchLiveGasPrice(chainId, provider);

    // Apply circuit breaker
    this.enforceCircuitBreaker(chainId, liveData);

    // Cache the result
    this.cache.set(cacheKey, {
      data: liveData,
      timestamp: Date.now()
    });

    return liveData;
  }

  /**
   * Fetch live gas price from provider or specialized APIs
   */
  private async fetchLiveGasPrice(
    chainId: ChainId,
    provider: ethers.Provider
  ): Promise<GasPriceData> {
    try {
      // Special handling for Polygon - use Gas Station API
      if (chainId === 'POLYGON') {
        const polygonData = await this.fetchPolygonGasStation();
        if (polygonData) {
          console.log(`[GasPriceOracle] Fetched Polygon gas price from Gas Station: ${ethers.formatUnits(polygonData.maxFeePerGas, 'gwei')} gwei`);
          return polygonData;
        }
        // Fall through to provider if Gas Station fails
        console.warn(`[GasPriceOracle] Polygon Gas Station unavailable, falling back to RPC`);
      }

      // Query provider for gas price (works for all EVM chains)
      const feeData = await provider.getFeeData();

      // Extract prices with fallbacks
      const gasPrice = feeData.gasPrice || ethers.parseUnits('50', 'gwei');
      const maxFeePerGas = feeData.maxFeePerGas || gasPrice;
      const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits('2', 'gwei');

      console.log(`[GasPriceOracle] Fetched live gas price for ${chainId}: ${ethers.formatUnits(maxFeePerGas, 'gwei')} gwei (priority: ${ethers.formatUnits(maxPriorityFeePerGas, 'gwei')} gwei)`);

      return {
        gasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
        timestamp: Date.now(),
        source: 'live'
      };
    } catch (error: any) {
      console.error(`[GasPriceOracle] Failed to fetch gas price for ${chainId}:`, error.message);
      return this.getFallbackGasPrice(chainId);
    }
  }

  /**
   * Fetch gas price from Polygon Gas Station API
   * More reliable and accurate than RPC for Polygon
   */
  private async fetchPolygonGasStation(): Promise<GasPriceData | null> {
    try {
      const response = await fetch('https://gasstation.polygon.technology/v2', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as {
        fast: { maxFee: number; maxPriorityFee: number };
      };

      // Gas Station returns prices in gwei
      const maxFeePerGas = ethers.parseUnits(data.fast.maxFee.toFixed(9), 'gwei');
      const maxPriorityFeePerGas = ethers.parseUnits(data.fast.maxPriorityFee.toFixed(9), 'gwei');
      const gasPrice = maxFeePerGas; // Use maxFee as gasPrice for compatibility

      return {
        gasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
        timestamp: Date.now(),
        source: 'live'
      };
    } catch (error: any) {
      console.warn(`[GasPriceOracle] Polygon Gas Station fetch failed:`, error.message);
      return null;
    }
  }

  /**
   * Get fallback gas prices when live queries fail
   */
  private getFallbackGasPrice(chainId: ChainId): GasPriceData {
    // Conservative fallback prices (in wei)
    const fallbacks: Record<string, bigint> = {
      'ETH': ethers.parseUnits('30', 'gwei'),
      'SEPOLIA': ethers.parseUnits('10', 'gwei'),
      'POLYGON': ethers.parseUnits('100', 'gwei'),
      'BASE': ethers.parseUnits('1', 'gwei'),
      'BSC': ethers.parseUnits('5', 'gwei'),
    };

    const gasPrice = fallbacks[chainId] || ethers.parseUnits('50', 'gwei');
    const maxPriorityFeePerGas = gasPrice / 10n; // 10% of gasPrice

    console.warn(`[GasPriceOracle] Using fallback gas price for ${chainId}: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);

    return {
      gasPrice,
      maxFeePerGas: gasPrice + maxPriorityFeePerGas,
      maxPriorityFeePerGas,
      timestamp: Date.now(),
      source: 'fallback'
    };
  }

  /**
   * Enforce circuit breaker - reject unreasonably high gas prices
   */
  private enforceCircuitBreaker(chainId: ChainId, data: GasPriceData): void {
    const maxAllowed = this.maxGasPrices[chainId];

    if (!maxAllowed) {
      return; // No limit configured for this chain
    }

    if (data.maxFeePerGas > maxAllowed) {
      const actual = ethers.formatUnits(data.maxFeePerGas, 'gwei');
      const limit = ethers.formatUnits(maxAllowed, 'gwei');

      console.error(`[GasPriceOracle] CIRCUIT BREAKER TRIGGERED for ${chainId}: ${actual} gwei exceeds limit of ${limit} gwei`);

      throw new Error(
        `Gas price ${actual} gwei exceeds circuit breaker limit of ${limit} gwei for ${chainId}. ` +
        `This may indicate extreme network congestion or a pricing error.`
      );
    }
  }

  /**
   * Clear cache for a specific chain or all chains
   */
  clearCache(chainId?: ChainId): void {
    if (chainId) {
      this.cache.delete(chainId);
      console.log(`[GasPriceOracle] Cleared cache for ${chainId}`);
    } else {
      this.cache.clear();
      console.log(`[GasPriceOracle] Cleared all cached gas prices`);
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; chains: ChainId[]; oldestAge: number } {
    const now = Date.now();
    let oldestAge = 0;

    for (const entry of this.cache.values()) {
      const age = now - entry.timestamp;
      if (age > oldestAge) {
        oldestAge = age;
      }
    }

    return {
      size: this.cache.size,
      chains: Array.from(this.cache.keys()) as ChainId[],
      oldestAge: Math.floor(oldestAge / 1000) // in seconds
    };
  }
}
