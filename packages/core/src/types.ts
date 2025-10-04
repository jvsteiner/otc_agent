export type ChainId =
  | 'UNICITY'
  | 'ETH' | 'POLYGON' | 'BASE' | 'SOLANA' | 'BTC'
  | `EVM:${string}`
  | `CUSTOM:${string}`;

export type AssetCode =
  | 'ALPHA' // native Alpha on Unicity (without chain suffix)
  | 'ALPHA@UNICITY' // alias to native Alpha on Unicity
  | 'ALPHA@ETH'
  | 'ETH' | 'ETH@ETH' // native ETH on Ethereum
  | 'MATIC' | 'MATIC@POLYGON' // native MATIC on Polygon
  | 'SOL' | 'USDT' | 'USDC' | 'BTC'
  | `ERC20:${string}` // 0x… address
  | `SPL:${string}`
  | `CUSTOM:${string}`;

export interface DealAssetSpec {
  chainId: ChainId;
  asset: AssetCode;
  amount: string; // decimal string
}

export type CommissionMode = 'PERCENT_BPS' | 'FIXED_USD_NATIVE';

export interface PriceOracleInfo {
  source: 'CHAINLINK' | 'PYTH' | 'MANUAL';
  pair: string;      // e.g., 'ETH/USD'
  price: string;     // numeric as string
  asOf: string;      // ISO time
}

export interface CommissionRequirement {
  mode: CommissionMode;
  currency: 'ASSET' | 'NATIVE';
  percentBps?: number;      // PERCENT_BPS
  usdFixed?: string;        // FIXED_USD_NATIVE
  nativeFixed?: string;     // frozen native amount (computed at COUNTDOWN)
  nativeSymbol?: string;    // ETH|MATIC|SOL...
  oracle?: PriceOracleInfo; // for FIXED_USD_NATIVE
  coveredBySurplus: true;
  allowCrossCover?: boolean;
}

export interface PartyDetails {
  paybackAddress: string;
  recipientAddress: string;
  email?: string;
  filledAt?: string;
  locked?: boolean;
}

export type DealStage = 'CREATED' | 'COLLECTION' | 'WAITING' | 'REVERTED' | 'CLOSED';

export interface EscrowAccountRef {
  chainId: ChainId;
  address: string;
  keyRef?: string; // keystore id
}

export interface EscrowDeposit {
  txid: string;
  index?: number;      // vout/logIndex
  amount: string;
  asset: AssetCode;
  blockHeight?: number;
  blockTime?: string;  // ISO
  confirms: number;
}

export interface SideLocks {
  tradeLockedAt?: string;
  commissionLockedAt?: string;
}

export interface DealSideState {
  deposits: EscrowDeposit[];
  collectedByAsset: Record<string, string>;
  locks: SideLocks;
}

export type QueuePurpose = 'SWAP_PAYOUT' | 'OP_COMMISSION' | 'SURPLUS_REFUND' | 'TIMEOUT_REFUND' | 'GAS_REFUND_TO_TANK';

export type QueuePhase = 'PHASE_1_SWAP' | 'PHASE_2_COMMISSION' | 'PHASE_3_REFUND';

export interface TxRef {
  txid: string;
  chainId: ChainId;
  submittedAt: string;
  confirms: number;
  requiredConfirms: number;
  status: 'PENDING' | 'CONFIRMED' | 'DROPPED' | 'REPLACED';
  nonceOrInputs?: string; // serialized
  // For Unicity multi-UTXO transactions, store all transaction IDs
  additionalTxids?: string[]; 
}

export interface QueueItem {
  id: string;
  dealId: string;
  chainId: ChainId;
  from: EscrowAccountRef;
  to: string;
  asset: AssetCode;
  amount: string;
  purpose: QueuePurpose;
  phase?: QueuePhase;     // For UTXO chains, determines execution order
  seq: number;            // strict per (dealId, from.address)
  status: 'PENDING' | 'SUBMITTED' | 'COMPLETED';
  createdAt: string;
  submittedTx?: TxRef;
}

export interface Deal {
  id: string;
  createdAt: string;
  timeoutSeconds: number;
  expiresAt?: string;
  stage: DealStage;

  alice: DealAssetSpec;
  bob: DealAssetSpec;
  aliceDetails?: PartyDetails;
  bobDetails?: PartyDetails;

  escrowA?: EscrowAccountRef; // Alice send chain
  escrowB?: EscrowAccountRef; // Bob send chain

  // side states
  sideAState?: DealSideState;
  sideBState?: DealSideState;

  // commission plan frozen at COUNTDOWN start
  commissionPlan: {
    sideA: CommissionRequirement;
    sideB: CommissionRequirement;
  };

  // queues
  outQueue: QueueItem[];
  refundQueue: QueueItem[];

  events: Array<{ t: string; msg: string }>;
}