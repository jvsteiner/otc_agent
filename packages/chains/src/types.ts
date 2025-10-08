/**
 * @fileoverview Additional type definitions for chain plugins.
 * Extends core ChainPlugin types with implementation-specific interfaces.
 */

// Re-export ChainPlugin types
export * from './ChainPlugin';

/**
 * Generic configuration interface for plugin initialization.
 * Used for simplified plugin setup in testing and development.
 */
export interface PluginConfig {
  chainId?: string;
  name?: string;
  rpcUrl?: string;
  electrumUrl?: string;
  requiredConfirmations?: number;
  operator?: { address: string };
  hotWalletSeed?: string;
}

/**
 * Request structure for sending a blockchain transaction.
 * Contains all necessary information for asset transfers.
 */
export interface TransactionRequest {
  from: string;
  to: string;
  asset: string;
  amount: string;
  memo?: string;
}

/**
 * Status information for a blockchain transaction.
 * Used to track transaction confirmation progress.
 */
export interface TransactionStatus {
  confirmed: boolean;
  confirmations: number;
  blockHeight?: number;
  error?: string;
}

/**
 * Escrow account details including keys and derivation path.
 * Contains sensitive information that should be handled securely.
 */
export interface EscrowAccount {
  address: string;
  privateKey: string;
  mnemonic?: string;
  path?: string;
}

/**
 * Oracle price quote for native currency conversion.
 * Used internally for commission calculations.
 */
export interface OracleQuote {
  nativeAmount: string;
  quote: {
    pair: string;
    price: string;
    timestamp: string;
  };
}