/**
 * @fileoverview Core ChainPlugin interface and types for blockchain interaction abstraction.
 * This module defines the contract that all blockchain adapters must implement to integrate
 * with the OTC broker engine. It provides a unified API for escrow management, deposit tracking,
 * and transaction submission across different blockchain architectures (UTXO, account-based, etc).
 */

import { ChainId, AssetCode, EscrowAccountRef, EscrowDeposit } from '@otc-broker/core';

/**
 * Configuration object for initializing a chain plugin.
 * Contains chain-specific parameters and credentials needed for blockchain interaction.
 */
export interface ChainConfig {
  chainId: ChainId;
  rpcUrl?: string;          // EVM-like
  electrumUrl?: string;     // BTC-like
  confirmations: number;    // practical finality
  collectConfirms?: number; // for deposits ≥ this to count for locks
  operator: { address: string };

  // Commission policy presets by asset pattern; 'ERC20:*' acts as fallback.
  commissionPolicy?: Record<string, {
    mode: 'PERCENT_BPS' | 'FIXED_USD_NATIVE';
    percentBps?: number;
    usdFixed?: string;
    currency?: 'ASSET' | 'NATIVE';
  }>;

  hotWalletSeed?: string;   // derivation root for escrows
  feePayerKeyRef?: string;  // optional fee payer for gas top-ups
  database?: any;           // Optional database reference for persistence
}

/**
 * Represents a balance query result for an address.
 * Used for querying current balances without transaction history.
 */
export interface BalanceView {
  asset: AssetCode;
  address: string;
  amount: string;
  updatedAt: string;
}

/**
 * Detailed view of confirmed deposits to an escrow address.
 * Includes individual deposit transactions and aggregated totals.
 */
export interface EscrowDepositsView {
  address: string;
  asset: AssetCode;
  minConf: number;
  deposits: EscrowDeposit[];
  totalConfirmed: string;
  updatedAt: string;
}

/**
 * Price quote from an oracle or manual configuration.
 * Used for converting USD amounts to native currency for commission calculations.
 */
export interface PriceQuote {
  pair: string;     // e.g., ETH/USD
  price: string;    // numeric as string
  asOf: string;     // ISO
  source: 'CHAINLINK' | 'PYTH' | 'MANUAL';
}

/**
 * Result of converting USD amount to native currency.
 * Includes the calculated amount and the price quote used.
 */
export interface QuoteNativeForUSDResult {
  nativeAmount: string;
  quote: PriceQuote;
}

/**
 * Information about a submitted blockchain transaction.
 * Includes transaction ID and metadata for tracking.
 */
export interface SubmittedTx {
  txid: string;
  submittedAt: string;
  nonceOrInputs?: string;
  // For Unicity multi-UTXO transactions, store additional transaction IDs
  additionalTxids?: string[];
  // Gas price used for the transaction (in gwei for EVM chains)
  gasPrice?: string;
}

/**
 * Core interface that all blockchain plugins must implement.
 * Provides abstraction for escrow management, deposit tracking, and transaction submission.
 * Implementations handle chain-specific details while exposing a uniform API to the engine.
 */
export interface ChainPlugin {
  readonly chainId: ChainId;

  /**
   * Initialize the plugin with chain-specific configuration.
   * Sets up connections, wallets, and network parameters.
   * @param cfg - Chain configuration including RPC URLs, confirmations, and operator details
   */
  init(cfg: ChainConfig): Promise<void>;

  /**
   * Generate a deterministic escrow account for a deal party.
   * Uses HD derivation to ensure unique addresses per deal/party combination.
   * @param asset - The asset code that will be held in this escrow
   * @param dealId - Unique deal identifier for deterministic derivation
   * @param party - Either 'ALICE' or 'BOB' to differentiate parties
   * @returns Escrow account reference with address and key reference
   */
  generateEscrowAccount(asset: AssetCode, dealId?: string, party?: 'ALICE' | 'BOB'): Promise<EscrowAccountRef>;

  /**
   * Retrieve the blockchain address from an escrow account reference.
   * @param ref - The escrow account reference
   * @returns The blockchain address as a string
   */
  getManagedAddress(ref: EscrowAccountRef): Promise<string>;

  /**
   * List all confirmed deposits to an escrow address that meet the confirmation threshold.
   * This is the primary method for detecting when parties have deposited funds.
   * @param asset - The asset to check deposits for
   * @param address - The escrow address to monitor
   * @param minConf - Minimum confirmations required for deposits to be considered
   * @param since - Optional ISO timestamp to filter deposits after this time
   * @returns View of all qualifying deposits with total confirmed amount
   */
  listConfirmedDeposits(
    asset: AssetCode,
    address: string,
    minConf: number,
    since?: string
  ): Promise<EscrowDepositsView>;

  /**
   * Convert a USD amount to native currency using current exchange rates.
   * Used for calculating commission amounts in FIXED_USD_NATIVE mode.
   * @param usd - The USD amount to convert
   * @returns Native currency amount and the price quote used
   */
  quoteNativeForUSD(usd: string): Promise<QuoteNativeForUSDResult>;

  /**
   * Send assets from an escrow account to a destination address.
   * Handles both native currency and token transfers with proper nonce/UTXO management.
   * @param asset - The asset to send
   * @param from - The escrow account to send from
   * @param to - The destination address
   * @param amount - The amount to send (as a decimal string)
   * @param options - Optional parameters for transaction submission (nonce, gas price for EVM chains)
   * @returns Transaction submission details
   */
  send(
    asset: AssetCode,
    from: EscrowAccountRef,
    to: string,
    amount: string,
    options?: any  // Chain-specific options (e.g., nonce for EVM)
  ): Promise<SubmittedTx>;

  /**
   * Ensure an escrow account has sufficient native currency for transaction fees.
   * May trigger gas funding from operator wallet if needed.
   * @param from - The escrow account to check
   * @param asset - The asset that will be transferred
   * @param intent - Whether sending native currency or tokens
   * @param minNative - Minimum native currency required
   */
  ensureFeeBudget(from: EscrowAccountRef, asset: AssetCode, intent: 'NATIVE'|'TOKEN', minNative: string): Promise<void>;

  /**
   * Get the number of confirmations for a transaction.
   * Returns -1 if the transaction has been reorganized or doesn't exist.
   * @param txid - The transaction ID to check
   * @returns Number of confirmations, or -1 if reorg/not found
   */
  getTxConfirmations(txid: string): Promise<number>;

  /**
   * Validate if an address is valid for this blockchain.
   * @param address - The address to validate
   * @returns True if valid, false otherwise
   */
  validateAddress(address: string): boolean;

  /**
   * Get the operator address configured for this chain.
   * Used as the destination for commission payments.
   * @returns The operator's blockchain address
   */
  getOperatorAddress(): string;
}