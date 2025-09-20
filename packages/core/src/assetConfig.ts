import assetConfigJson from './config/assets.json';

export interface AssetConfig {
  assetName: string;
  assetSymbol: string;
  chainId: string;
  native: boolean;
  type: 'NATIVE' | 'ERC20' | 'ERC721' | 'ERC1155' | 'SPL';
  contractAddress: string | null;
  tokenId: string | null;
  decimals: number;
  icon: string;
}

export interface ChainConfig {
  chainId: string;
  name: string;
  icon: string;
}

export interface AssetRegistry {
  assets: AssetConfig[];
  supportedChains: ChainConfig[];
}

// Load asset configuration with type assertion
const assetRegistry: AssetRegistry = assetConfigJson as AssetRegistry;

export function getAssetRegistry(): AssetRegistry {
  return assetRegistry;
}

export function getAssetsByChain(chainId: string): AssetConfig[] {
  return assetRegistry.assets.filter(asset => asset.chainId === chainId);
}

export function getAsset(chainId: string, symbol: string): AssetConfig | undefined {
  return assetRegistry.assets.find(
    asset => asset.chainId === chainId && asset.assetSymbol === symbol
  );
}

export function getAssetByContract(chainId: string, contractAddress: string): AssetConfig | undefined {
  return assetRegistry.assets.find(
    asset => asset.chainId === chainId && 
    asset.contractAddress?.toLowerCase() === contractAddress.toLowerCase()
  );
}

export function getSupportedChains(): ChainConfig[] {
  return assetRegistry.supportedChains;
}

export function getChainInfo(chainId: string): ChainConfig | undefined {
  return assetRegistry.supportedChains.find(chain => chain.chainId === chainId);
}

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