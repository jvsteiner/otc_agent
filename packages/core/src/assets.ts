/**
 * @fileoverview Asset metadata management and chain configurations.
 * This module provides runtime asset information including decimal places,
 * minimum sendable amounts, and chain-specific confirmation thresholds.
 * Works alongside assetConfig.ts for complete asset management.
 */

import { ChainId, AssetCode } from './types';
import { parseAmount } from './decimal';

/**
 * Runtime metadata for an asset including precision and chain information.
 */
export interface AssetMetadata {
  /** Display symbol for the asset (ETH, MATIC, ALPHA) */
  symbol: string;
  /** Number of decimal places for this asset */
  decimals: number;
  /** Minimum amount that can be sent on-chain */
  minSendable: string; // minimum amount that can be sent
  /** Whether this is the native token of its chain */
  isNative: boolean;
  /** The blockchain this asset belongs to */
  chainId: ChainId;
}

const ASSET_METADATA: Record<string, AssetMetadata> = {
  'ALPHA@UNICITY': {
    symbol: 'ALPHA',
    decimals: 8,
    minSendable: '0.00001', // 1000 satoshis
    isNative: true,
    chainId: 'UNICITY',
  },
  'ETH': {
    symbol: 'ETH',
    decimals: 18,
    minSendable: '0.000001', // 1 million gwei
    isNative: true,
    chainId: 'ETH',
  },
  'MATIC': {
    symbol: 'MATIC',
    decimals: 18,
    minSendable: '0.0001',
    isNative: true,
    chainId: 'POLYGON',
  },
  'SOL': {
    symbol: 'SOL',
    decimals: 9,
    minSendable: '0.000001',
    isNative: true,
    chainId: 'SOLANA',
  },
  'BTC': {
    symbol: 'BTC',
    decimals: 8,
    minSendable: '0.00001',
    isNative: true,
    chainId: 'BTC',
  },
  'USDT': {
    symbol: 'USDT',
    decimals: 6,
    minSendable: '0.01',
    isNative: false,
    chainId: 'ETH', // default to ETH, but exists on multiple chains
  },
  'USDC': {
    symbol: 'USDC',
    decimals: 6,
    minSendable: '0.01',
    isNative: false,
    chainId: 'ETH', // default to ETH, but exists on multiple chains
  },
};

/**
 * Retrieves metadata for a specific asset on a given chain.
 * Returns default values for unknown ERC20 and SPL tokens.
 *
 * @param asset - The asset code to look up
 * @param chainId - The blockchain where the asset resides
 * @returns Asset metadata or undefined if not found
 *
 * @example
 * getAssetMetadata('ETH', 'ETH') // { symbol: 'ETH', decimals: 18, ... }
 * getAssetMetadata('ERC20:0x...', 'ETH') // Default ERC20 metadata
 */
export function getAssetMetadata(asset: AssetCode, chainId: ChainId): AssetMetadata | undefined {
  // Check direct lookup first
  if (ASSET_METADATA[asset]) {
    return ASSET_METADATA[asset];
  }
  
  // Handle ERC20 tokens
  if (asset.startsWith('ERC20:')) {
    return {
      symbol: 'TOKEN',
      decimals: 18, // default, should be fetched from chain
      minSendable: '0.00001',
      isNative: false,
      chainId,
    };
  }
  
  // Handle SPL tokens
  if (asset.startsWith('SPL:')) {
    return {
      symbol: 'TOKEN',
      decimals: 9, // default for Solana
      minSendable: '0.00001',
      isNative: false,
      chainId: 'SOLANA',
    };
  }
  
  return undefined;
}

/**
 * Returns the native asset code for a given blockchain.
 * Used to identify gas tokens for commission payments.
 *
 * @param chainId - The blockchain to get the native asset for
 * @returns The asset code of the native token
 * @throws Error if the chain is unknown
 *
 * @example
 * getNativeAsset('ETH') // 'ETH'
 * getNativeAsset('POLYGON') // 'MATIC'
 * getNativeAsset('UNICITY') // 'ALPHA@UNICITY'
 */
export function getNativeAsset(chainId: ChainId): AssetCode {
  switch (chainId) {
    case 'UNICITY':
      return 'ALPHA@UNICITY';
    case 'ETH':
      return 'ETH';
    case 'POLYGON':
      return 'MATIC';
    case 'SOLANA':
      return 'SOL';
    case 'BTC':
      return 'BTC';
    default:
      if (chainId.startsWith('EVM:')) {
        return 'ETH'; // default for unknown EVM chains
      }
      throw new Error(`Unknown native asset for chain ${chainId}`);
  }
}

/**
 * Checks if an amount meets the minimum sendable threshold for an asset.
 * Used to validate that transaction amounts are viable on-chain.
 *
 * @param amount - The amount to validate as a string
 * @param asset - The asset code
 * @param chainId - The blockchain for the transaction
 * @returns true if amount is above minimum, false otherwise
 *
 * @example
 * isAboveMinSendable("0.1", "ETH", "ETH") // true
 * isAboveMinSendable("0.0000001", "ETH", "ETH") // false (below min)
 */
export function isAboveMinSendable(amount: string, asset: AssetCode, chainId: ChainId): boolean {
  const metadata = getAssetMetadata(asset, chainId);
  if (!metadata) return true; // assume OK if no metadata
  
  const amountDecimal = parseAmount(amount);
  const minSendableDecimal = parseAmount(metadata.minSendable);
  return amountDecimal.gte(minSendableDecimal);
}

/**
 * Returns the minimum number of confirmations required for a blockchain.
 * These thresholds balance security with reasonable wait times.
 *
 * @param chainId - The blockchain to get confirmation threshold for
 * @returns Number of confirmations required for finality
 *
 * @example
 * getConfirmationThreshold('ETH') // 3
 * getConfirmationThreshold('POLYGON') // 64 (higher due to potential reorgs)
 * getConfirmationThreshold('UNICITY') // 6
 */
export function getConfirmationThreshold(chainId: ChainId): number {
  switch (chainId) {
    case 'UNICITY':
      return 6;
    case 'ETH':
      return 3;
    case 'POLYGON':
      return 64;
    case 'SOLANA':
      return 10;
    case 'BTC':
      return 2;
    default:
      if (chainId.startsWith('EVM:')) {
        return 12; // conservative default
      }
      return 6;
  }
}