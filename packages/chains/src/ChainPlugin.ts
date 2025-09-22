import { ChainId, AssetCode, EscrowAccountRef, EscrowDeposit } from '@otc-broker/core';

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

export interface BalanceView {
  asset: AssetCode;
  address: string;
  amount: string;
  updatedAt: string;
}

export interface EscrowDepositsView {
  address: string;
  asset: AssetCode;
  minConf: number;
  deposits: EscrowDeposit[];
  totalConfirmed: string;
  updatedAt: string;
}

export interface PriceQuote {
  pair: string;     // e.g., ETH/USD
  price: string;    // numeric as string
  asOf: string;     // ISO
  source: 'CHAINLINK' | 'PYTH' | 'MANUAL';
}

export interface QuoteNativeForUSDResult {
  nativeAmount: string;
  quote: PriceQuote;
}

export interface SubmittedTx {
  txid: string;
  submittedAt: string;
  nonceOrInputs?: string;
}

export interface ChainPlugin {
  readonly chainId: ChainId;
  init(cfg: ChainConfig): Promise<void>;

  // Managed escrows
  generateEscrowAccount(asset: AssetCode, dealId?: string, party?: 'ALICE' | 'BOB'): Promise<EscrowAccountRef>;
  getManagedAddress(ref: EscrowAccountRef): Promise<string>;

  // Deposit enumeration (confirmed only)
  listConfirmedDeposits(
    asset: AssetCode,
    address: string,
    minConf: number,
    since?: string
  ): Promise<EscrowDepositsView>;

  // Pricing (for FIXED_USD_NATIVE commission)
  quoteNativeForUSD(usd: string): Promise<QuoteNativeForUSDResult>;

  // Sending (must ensure per-account serialization)
  send(asset: AssetCode, from: EscrowAccountRef, to: string, amount: string): Promise<SubmittedTx>;

  // Fee & validation
  ensureFeeBudget(from: EscrowAccountRef, asset: AssetCode, intent: 'NATIVE'|'TOKEN', minNative: string): Promise<void>;
  getTxConfirmations(txid: string): Promise<number>;
  validateAddress(address: string): boolean;
  getOperatorAddress(): string;
}