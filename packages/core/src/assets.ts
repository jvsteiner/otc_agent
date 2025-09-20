import { ChainId, AssetCode } from './types';
import { parseAmount } from './decimal';

export interface AssetMetadata {
  symbol: string;
  decimals: number;
  minSendable: string; // minimum amount that can be sent
  isNative: boolean;
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

export function isAboveMinSendable(amount: string, asset: AssetCode, chainId: ChainId): boolean {
  const metadata = getAssetMetadata(asset, chainId);
  if (!metadata) return true; // assume OK if no metadata
  
  const amountDecimal = parseAmount(amount);
  const minSendableDecimal = parseAmount(metadata.minSendable);
  return amountDecimal.gte(minSendableDecimal);
}

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