/**
 * @fileoverview Asset configuration and registry management.
 * This module loads and provides access to the static asset configuration
 * from assets.json, including supported chains and token metadata.
 * Used for UI display, asset discovery, and blockchain explorer links.
 */

import assetConfigJson from './config/assets.json';

/**
 * Configuration for a supported asset including display and contract information.
 */
export interface AssetConfig {
  /** Full display name of the asset (e.g., "Ethereum") */
  assetName: string;
  /** Trading symbol (e.g., "ETH") */
  assetSymbol: string;
  /** Blockchain identifier this asset belongs to */
  chainId: string;
  /** Whether this is the native token of its chain */
  native: boolean;
  /** Token standard type */
  type: 'NATIVE' | 'ERC20' | 'ERC721' | 'ERC1155' | 'SPL';
  /** Smart contract address for non-native tokens */
  contractAddress: string | null;
  /** Token ID for NFTs (ERC721/ERC1155) */
  tokenId: string | null;
  /** Number of decimal places for this asset */
  decimals: number;
  /** Unicode/emoji icon for display */
  icon: string;
  /** Optional custom URL for asset information */
  url?: string;
}

/**
 * Configuration for a supported blockchain.
 */
export interface ChainConfig {
  /** Unique blockchain identifier */
  chainId: string;
  /** Display name of the blockchain */
  name: string;
  /** Unicode/emoji icon for display */
  icon: string;
}

/**
 * Complete registry of supported assets and chains.
 */
export interface AssetRegistry {
  /** All supported assets across all chains */
  assets: AssetConfig[];
  /** All supported blockchains */
  supportedChains: ChainConfig[];
}

// Load asset configuration with type assertion
const assetRegistry: AssetRegistry = assetConfigJson as AssetRegistry;

/**
 * Returns the complete asset registry loaded from configuration.
 *
 * @returns The full asset registry with assets and chains
 */
export function getAssetRegistry(): AssetRegistry {
  return assetRegistry;
}

/**
 * Gets all assets available on a specific blockchain.
 *
 * @param chainId - The blockchain to filter assets for
 * @returns Array of assets on the specified chain
 *
 * @example
 * getAssetsByChain('ETH') // Returns ETH, USDT, USDC, EURC on Ethereum
 */
export function getAssetsByChain(chainId: string): AssetConfig[] {
  return assetRegistry.assets.filter(asset => asset.chainId === chainId);
}

/**
 * Finds a specific asset by chain and symbol.
 *
 * @param chainId - The blockchain to search
 * @param symbol - The asset symbol to find
 * @returns Asset configuration or undefined if not found
 *
 * @example
 * getAsset('ETH', 'USDT') // Returns USDT configuration on Ethereum
 */
export function getAsset(chainId: string, symbol: string): AssetConfig | undefined {
  return assetRegistry.assets.find(
    asset => asset.chainId === chainId && asset.assetSymbol === symbol
  );
}

/**
 * Finds a token by its smart contract address.
 *
 * @param chainId - The blockchain to search
 * @param contractAddress - The contract address to find
 * @returns Asset configuration or undefined if not found
 *
 * @example
 * getAssetByContract('ETH', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') // USDC
 */
export function getAssetByContract(chainId: string, contractAddress: string): AssetConfig | undefined {
  return assetRegistry.assets.find(
    asset => asset.chainId === chainId &&
    asset.contractAddress?.toLowerCase() === contractAddress.toLowerCase()
  );
}

/**
 * Returns all supported blockchain configurations.
 *
 * @returns Array of supported chain configurations
 */
export function getSupportedChains(): ChainConfig[] {
  return assetRegistry.supportedChains;
}

/**
 * Gets configuration for a specific blockchain.
 *
 * @param chainId - The blockchain identifier
 * @returns Chain configuration or undefined if not found
 *
 * @example
 * getChainInfo('ETH') // { chainId: 'ETH', name: 'Ethereum', icon: 'Ξ' }
 */
export function getChainInfo(chainId: string): ChainConfig | undefined {
  return assetRegistry.supportedChains.find(chain => chain.chainId === chainId);
}

/**
 * Formats an asset configuration into a canonical asset code.
 * Used to generate standardized identifiers for assets.
 *
 * @param asset - The asset configuration to format
 * @returns Formatted asset code string
 *
 * @example
 * formatAssetCode(ethConfig) // 'ETH'
 * formatAssetCode(usdtConfig) // 'ERC20:0xdAC17F958D2ee523a2206206994597C13D831ec7'
 */
export function formatAssetCode(asset: AssetConfig): string {
  if (asset.native) {
    return asset.assetSymbol;
  }
  if (asset.type === 'ERC20' || asset.type === 'SPL') {
    return `${asset.type}:${asset.contractAddress}`;
  }
  if (asset.type === 'ERC721' || asset.type === 'ERC1155') {
    return `${asset.type}:${asset.contractAddress}:${asset.tokenId || ''}`;
  }
  return asset.assetSymbol;
}

/**
 * Parses an asset code string to find its configuration.
 * Handles native assets, contract addresses, and symbol lookups.
 *
 * @param assetCode - The asset code to parse (e.g., 'ETH', 'ERC20:0x...')
 * @param chainId - The blockchain context for parsing
 * @returns Asset configuration or undefined if not found
 *
 * @example
 * parseAssetCode('ETH', 'ETH') // Native ETH configuration
 * parseAssetCode('ERC20:0xA0b86991...', 'ETH') // USDC configuration
 */
export function parseAssetCode(assetCode: string, chainId: string): AssetConfig | undefined {
  // Handle native assets
  const nativeAsset = assetRegistry.assets.find(
    asset => asset.chainId === chainId && asset.native && asset.assetSymbol === assetCode
  );
  if (nativeAsset) return nativeAsset;

  // Handle contract-based assets
  if (assetCode.includes(':')) {
    const parts = assetCode.split(':');
    const type = parts[0];
    const contractAddress = parts[1];
    
    return assetRegistry.assets.find(
      asset => asset.chainId === chainId && 
      asset.type === type &&
      asset.contractAddress?.toLowerCase() === contractAddress.toLowerCase()
    );
  }

  // Try to find by symbol
  return assetRegistry.assets.find(
    asset => asset.chainId === chainId && asset.assetSymbol === assetCode
  );
}

/**
 * Generates a blockchain explorer URL for an asset.
 * Returns custom URL if specified, otherwise generates explorer links.
 *
 * @param asset - The asset configuration
 * @returns URL to blockchain explorer or asset information page
 *
 * @example
 * getAssetUrl(ethAsset) // 'https://etherscan.io/'
 * getAssetUrl(usdcAsset) // 'https://etherscan.io/token/0xA0b86991...'
 */
export function getAssetUrl(asset: AssetConfig): string {
  // If asset has a custom URL, use it
  if (asset.url) {
    return asset.url;
  }
  
  // Generate blockchain explorer URLs
  switch (asset.chainId) {
    case 'UNICITY':
      return 'https://www.unicity.network/';
    
    case 'ETH':
      if (asset.native) {
        return 'https://etherscan.io/';
      } else if (asset.contractAddress) {
        return `https://etherscan.io/token/${asset.contractAddress}`;
      }
      break;
    
    case 'POLYGON':
      if (asset.native) {
        return 'https://polygonscan.com/';
      } else if (asset.contractAddress) {
        return `https://polygonscan.com/token/${asset.contractAddress}`;
      }
      break;
    
    case 'SOLANA':
      if (asset.native) {
        return 'https://solscan.io/';
      } else if (asset.contractAddress) {
        return `https://solscan.io/token/${asset.contractAddress}`;
      }
      break;
  }
  
  // Default fallback
  return '#';
}