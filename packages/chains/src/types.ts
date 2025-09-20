// Re-export ChainPlugin types
export * from './ChainPlugin';

// Additional types for our plugins
export interface PluginConfig {
  chainId?: string;
  name?: string;
  rpcUrl?: string;
  electrumUrl?: string;
  requiredConfirmations?: number;
  operator?: { address: string };
  hotWalletSeed?: string;
}

export interface TransactionRequest {
  from: string;
  to: string;
  asset: string;
  amount: string;
  memo?: string;
}

export interface TransactionStatus {
  confirmed: boolean;
  confirmations: number;
  blockHeight?: number;
  error?: string;
}

export interface EscrowAccount {
  address: string;
  privateKey: string;
  mnemonic?: string;
  path?: string;
}

export interface OracleQuote {
  nativeAmount: string;
  quote: {
    pair: string;
    price: string;
    timestamp: string;
  };
}