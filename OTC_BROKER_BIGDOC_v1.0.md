Below is a **single Markdown spec** designed for **Claude Code “YOLO mode”**.  
It contains **beacon substrings** and highly structured sections so Claude can reliably chunk‑read or jump to the right parts.

---

# BIGDOC v1.0 — Generic OTC Broker Engine (Unicity-must)  
`DOC-ID: OTC-UNICITY-BROKER-v1.0-2025-09-19`

> **Reading instructions for large docs (Claude Code, YOLO mode):**
> - Use the **Beacon Substrings** index below to jump to sections.  
> - Each section starts with `=== BEACON::<TAG>::START ===` and ends with `=== BEACON::<TAG>::END ===`.  
> - If you can’t load the whole file, read in fragments using the beacons in this order:
>   1. `INDEX` → 2. `GOALS` → 3. `POLICY` → 4. `THREATS` → 5. `TYPES` → 6. `PLUGIN_IFACE` → 7. `DB_SCHEMA` → 8. `ENGINE` → 9. `RPC_API` → 10. `FRONTEND` → 11. `CONFIG` → 12. `TESTS` → 13. `PACKETS`  
> - When implementing, **honor invariants** in `POLICY` and `THREATS` first.  
> - Stack: **TypeScript + Node.js + better-sqlite3 (WAL)**. One chain **must** be **Unicity PoW**.

---

## === BEACON::INDEX::START ===
- [BEACON::GOALS] Business Goals & Scope
- [BEACON::POLICY] Core Trade & Commission Policy (Authoritative)
- [BEACON::THREATS] Threat Model & Mitigations (Race/Reorg)
- [BEACON::ARCH] High-level Architecture
- [BEACON::TYPES] Core Types (TS)
- [BEACON::PLUGIN_IFACE] Chain Plugin Interface (TS)
- [BEACON::DB_SCHEMA] Database Schema & Migrations (SQLite)
- [BEACON::ENGINE] Engine Algorithm (30s loop, leases, planning)
- [BEACON::RPC_API] JSON-RPC API & HTTP pages
- [BEACON::FRONTEND] Minimal Frontend Requirements
- [BEACON::CONFIG] Configuration & Env
- [BEACON::TESTS] Simulators & E2E Test Matrix
- [BEACON::PACKETS] Execution Plan (Task Packets v3)
- [BEACON::EXAMPLES] Worked Examples
- [BEACON::FAQ] Operational Notes & FAQ
## === BEACON::INDEX::END ===

---

## === BEACON::GOALS::START ===
**Goal:** Implement a generic OTC “broker” that swaps assets between two parties (Alice, Bob) across chains. **At least one side must be Unicity PoW**. Engine manages **escrows**, **monitoring**, **swap distribution**, **refunds**, and **commissions**.

**Key constraints**
- Stack: TypeScript. Storage: **better-sqlite3** with **WAL**.  
- Each **deal is processed independently and in parallel**; enforced by **per‑deal leases**.  
- Commission & surplus rules in **POLICY** are authoritative.  
- Robust against **race conditions**, **chain reorgs**, **nonce/UTXO issues**, and **partial failures**.  
## === BEACON::GOALS::END ===

---

## === BEACON::POLICY::START ===
### 1) Deal & Escrow Flow (condensed)
- Creator defines what Alice sells (ChainID_A, Asset_A, Amount_A) and what Bob sells (ChainID_B, Asset_B, Amount_B), plus Timeout.
- System creates **personal links** for Alice (link_A) and Bob (link_B).
- Each party fills:
  - **Payback address** on their send chain.
  - **Recipient address** on the opposite chain.
  - Optional email.
- For each side, system generates an **escrow address** on the **send chain**.
- **Collection → Distribution**:
  - **Collection** waits for confirmed deposits (see confirms policy).
  - If both sides satisfy **all locks** (trade + commission) before `expiresAt`, plan & execute swap.
  - Else on timeout, **refund** confirmed deposits back to payers (no commission).
- UI shows live progress; optional email notifications.

### 2) **Commissions & Surplus (Authoritative)**
- **Commission is paid from surplus only** — **never** deducted from the **trade amount**.
- **Two commission modes** per side (frozen at COUNTDOWN):
  - **PERCENT_BPS** (for preconfigured assets):  
    - Commission = `floor(tradeAmount * percentBps / 10000, assetDecimals)`  
    - Commission **currency**: usually **ASSET** (or **NATIVE** if configured).
  - **FIXED_USD_NATIVE** (for unknown ERC‑20/SPL):  
    - Commission = **fixed USD** (e.g., `$10`) converted to the chain **native** coin using a **frozen quote** at COUNTDOWN, recorded as `nativeFixed`.
- **Coverage**: Each side must fund **its own** commission using **surplus** in the **commission currency** (ASSET or NATIVE).  
  - Default policy **disallows cross‑cover** from the other side’s surplus.
- **Trade amounts are sacrosanct**: exactly the specified trade amounts are swapped 1:1 across escrows.

### 3) **Lock Rules (must hold on both sides)**
A side is **ready** only when **both** locks are satisfied using deposits with:
- `confirms ≥ collectConfirms(chain)` **and**
- `blockTime ≤ expiresAt`.

Locks per side:
1. **Trade lock** for the **trade asset**: sum(eligible) ≥ expected trade amount.  
2. **Commission lock** for the **commission currency**:  
   - If PERCENT_BPS in ASSET: sum(eligible ASSET) ≥ computed commission.  
   - If FIXED_USD_NATIVE: sum(eligible NATIVE) ≥ `nativeFixed`.

### 4) Timeout & Late Funds
- If `now > expiresAt` and any lock missing on either side: **REVERT** → refund each party’s **confirmed deposits** (per asset) to the **payback** address. **No commission** collected on revert.
- Post‑close watcher (7 days): any **late confirmed deposit** to escrow is **auto‑refunded**.

### 5) Confirmations & Reorg Safety
- Use per‑chain `collectConfirms` ≥ “finality” threshold + safety margin (e.g., ETH 3, Polygon 64, Unicity 6, BTC 2+, Solana 10).  
- Deposits for locking are **confirmed**; pending do not count.
- We lock based on **blockTime ≤ expiresAt**, **not** observe-time, so near‑boundary blocks count if included before expiry.

### 6) Operator Commission Address
- Each chain plugin has a configured `operator.address`.  
- On successful swap, engine issues **OP_COMMISSION** transfer from the side’s escrow in the **commission currency**.
## === BEACON::POLICY::END ===

---

## === BEACON::THREATS::START ===
**Core risks & mitigations (must implement):**
1. **Duplicate execution / queueing** → **Per‑deal leases** in DB; **Transfer Plan** with idempotency persisted before broadcast.  
2. **Premature swap (reorg removes deposit)** → lock only from **confirmed** deposits; `collectConfirms ≥ finality+margin`.  
3. **Timeout edge (included before expiry, confirmed after)** → lock on **blockTime ≤ expiresAt**.  
4. **Partial distribution (one chain stalls)** → **Two‑phase**: Preflight (balances, fee budgets, nonces/UTXOs) → Plan → Broadcast FIFO per sender.  
5. **Crash between broadcast & persist** → submit inside a **DB tx**: `SUBMITTING → send → SUBMITTED(txid, nonce/inputs)` atomically.  
6. **EVM nonce/UTXO races** → per‑account **serial submission**; nonce/UTXO reservation in DB.  
7. **Balance vs deposits mismatch** → compute locks from **explicit deposits** (tx/log listings), not from raw balances.  
8. **Gas vs commission contention** → preflight reserves **native** for commission **and** all gas + safety.  
9. **Rounding/dust** → `floor` for commission; `minSendable` thresholds per asset; final sweep refunds residuals if ≥ threshold.  
10. **Late deposits after close** → post‑close watcher refunds.  
11. **Notification spam** → notification ledger uniqueness `(dealId,eventType,eventKey)`.  
12. **Oracle/price volatility** (for FIXED_USD_NATIVE) → **freeze native amount** at COUNTDOWN; if oracle unavailable, don’t start.

> These points must be reflected in **ENGINE**, **PLUGIN_IFACE**, **DB_SCHEMA**, **TESTS**.
## === BEACON::THREATS::END ===

---

## === BEACON::ARCH::START ===
- **packages/core**: types, invariants, state helpers.
- **packages/chains**: `ChainPlugin` + adapters (`Unicity`, `EVM`, `BTC` (optional), `Solana` (optional)).
- **packages/backend**: JSON‑RPC server, engine loop (30s), notifier, DAL.
- **packages/web**: static/SSR minimal pages (deal creation, personal pages).
- **packages/tools**: scripts, simulators, seeding.

**Parallelism:** deals processed independently; engine acquires **lease per deal**.

**Data flow:**  
UI/API → create deal → personal pages collect addresses → COUNTDOWN starts (freeze commission quotes if needed) → COLLECTION (confirmed deposits) → if both sides trade+commission locked → preflight → plan → broadcast → confirms → CLOSED; otherwise timeout → refunds.
## === BEACON::ARCH::END ===

---

## === BEACON::TYPES::START ===
```ts
// packages/core/src/types.ts
export type ChainId =
  | 'UNICITY'
  | 'ETH' | 'POLYGON' | 'SOLANA' | 'BTC'
  | `EVM:${string}`
  | `CUSTOM:${string}`;

export type AssetCode =
  | 'ALPHA@UNICITY' // alias to native Alpha on Unicity
  | 'ALPHA@ETH'
  | 'ETH' | 'MATIC' | 'SOL' | 'USDT' | 'USDC' | 'BTC'
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

export type QueuePurpose = 'SWAP_PAYOUT' | 'OP_COMMISSION' | 'SURPLUS_REFUND' | 'TIMEOUT_REFUND';

export interface TxRef {
  txid: string;
  chainId: ChainId;
  submittedAt: string;
  confirms: number;
  requiredConfirms: number;
  status: 'PENDING' | 'CONFIRMED' | 'DROPPED' | 'REPLACED';
  nonceOrInputs?: string; // serialized
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
  seq: number;            // strict per (dealId, from.address)
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
```
## === BEACON::TYPES::END ===

---

## === BEACON::PLUGIN_IFACE::START ===
```ts
// packages/chains/src/ChainPlugin.ts
import { ChainId, AssetCode, EscrowAccountRef, EscrowDeposit } from '@core/types';

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
  generateEscrowAccount(asset: AssetCode): Promise<EscrowAccountRef>;
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
}
```

**Adapters to deliver:**
- `UnicityPlugin` (must‑have; native Alpha; percent commission in ALPHA from surplus).
- `EvmPlugin` (ETH/Polygon; native + ERC‑20; unknown ERC‑20 → `$10` native commission).
- `SolanaPlugin` (optional v1; unknown SPL → `$10` SOL).
- `BtcPlugin` (optional v1).
## === BEACON::PLUGIN_IFACE::END ===

---

## === BEACON::DB_SCHEMA::START ===
**SQLite (better‑sqlite3) — enable WAL & pragmas on startup**
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

**Tables**
```sql
-- Deals
CREATE TABLE IF NOT EXISTS deals (
  dealId TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  json TEXT NOT NULL,          -- full Deal JSON snapshot (normalized minimal duplication OK)
  createdAt TEXT NOT NULL,
  expiresAt TEXT
);

-- Escrow deposits (confirmed only, dedup by (deal,txid,idx))
CREATE TABLE IF NOT EXISTS escrow_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealId TEXT NOT NULL,
  chainId TEXT NOT NULL,
  address TEXT NOT NULL,
  asset TEXT NOT NULL,
  txid TEXT NOT NULL,
  idx INTEGER,
  amount TEXT NOT NULL,
  blockHeight INTEGER,
  blockTime TEXT,
  confirms INTEGER NOT NULL,
  UNIQUE (dealId, txid, idx)
);

-- Queue items
CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  dealId TEXT NOT NULL,
  chainId TEXT NOT NULL,
  fromAddr TEXT NOT NULL,
  toAddr TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  purpose TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  submittedTx TEXT,            -- JSON TxRef
  createdAt TEXT NOT NULL
);

-- Accounts (nonce/UTXO tracking)
CREATE TABLE IF NOT EXISTS accounts (
  accountId TEXT PRIMARY KEY,  -- chainId|address
  chainId TEXT NOT NULL,
  address TEXT NOT NULL,
  lastUsedNonce INTEGER,       -- for account-based chains
  utxo_state TEXT              -- JSON snapshot if needed
);

-- Leases (per-deal processing lock)
CREATE TABLE IF NOT EXISTS leases (
  dealId TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL,
  leaseUntil TEXT NOT NULL
);

-- Events / audit trail
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealId TEXT NOT NULL,
  t TEXT NOT NULL,
  msg TEXT NOT NULL
);

-- Notifications (idempotency)
CREATE TABLE IF NOT EXISTS notifications (
  dealId TEXT NOT NULL,
  eventType TEXT NOT NULL,
  eventKey TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE (dealId, eventType, eventKey)
);

-- Optional: Oracle quotes cache
CREATE TABLE IF NOT EXISTS oracle_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chainId TEXT NOT NULL,
  pair TEXT NOT NULL,
  price TEXT NOT NULL,
  asOf TEXT NOT NULL,
  source TEXT NOT NULL
);
```

**Transaction helpers**
- All **stage transitions**, **plan creation**, and **queue enqueues** happen inside a **single DB tx**.
- Lease acquisition:
```sql
-- Pseudocode: UPDATE leases SET ownerId=?, leaseUntil=? WHERE dealId=? AND (leaseUntil < now OR ownerId=?)
```
## === BEACON::DB_SCHEMA::END ===

---

## === BEACON::ENGINE::START ===
**Loop cadence:** every 30s (configurable). **Per‑deal lease** duration: ~90s; extend before expiry.

### Pseudocode (core)
```ts
for each activeDeal:
  if (!acquireLease(dealId)) continue;

  // 1) READ deposits (confirmed only)
  for side in [A, B]:
    tradeAsset = side.trade.asset
    commReq = deal.commissionPlan[side]
    commAsset = (commReq.currency === 'ASSET') ? tradeAsset : nativeAssetOf(side.chain)
    // Pull confirmed deposits for tradeAsset & commAsset
    updTrade = plugin.listConfirmedDeposits(tradeAsset, escrow.address, collectConfirms)
    updComm  = plugin.listConfirmedDeposits(commAsset,  escrow.address, collectConfirms)
    upsertDeposits(dealId, updTrade.deposits)
    upsertDeposits(dealId, updComm.deposits)
    recomputeCollectedAndLocks(side, expectedTrade, requiredCommission, expiresAt)

  // 2) DECIDE
  if (deal.stage === 'COLLECTION'):
    if (bothSidesHaveTradeAndCommissionLocks(deal)):
      if (preflightAllChains(deal)):    // fees, gas, nonces/utxos, budgets
        persistTransferPlan(deal)       // SWAP_PAYOUT, OP_COMMISSION, SURPLUS_REFUNDs
        setStage(deal, 'WAITING')
      else:
        // remain in COLLECTION; retry
    else if (now > expiresAt):
      enqueueTimeoutRefunds(deal)       // refund confirmed amounts per-asset
      setStage(deal, 'REVERTED')

  else if (deal.stage in ['WAITING','REVERTED']):
    processQueuesFIFO(deal)             // strictly per sender; track confirms; handle DROPPED/REPLACED
    if (allQueuesConfirmed(deal)):
      setStage(deal, 'CLOSED')

  // 3) POST-CLOSE watcher
  scheduleLateDepositWatcher(deal)  // 7 days: auto-refund new confirmed deposits to payback
```

### Preflight (must-pass)
- Compute **native budget** per escrow:
  - `nativeForCommission(if currency=NATIVE)` + `gasAllPlannedTxs` + `safetyBuffer`.
- Ensure **feePayer** top‑ups or escrow balance sufficient.  
- Reserve **nonce/UTXO** for first submissions; persist in DB.

### Plan Builder
- For **each side’s escrow**:
  1. `SWAP_PAYOUT` → counterparty recipient (`amount = exact trade amount`).
  2. `OP_COMMISSION` → operator address (`amount = commission in ASSET or NATIVE`).
  3. `SURPLUS_REFUND` → payback address for each **asset** where collected > (trade + commission(if same asset)).
     - Surplus computed conservatively using **confirmed deposits**.
- Order items per **sender account** by `seq`.

### Queue processing
- One in‑flight tx per sender account; next waits until prior becomes `SUBMITTED`.
- Submission done in DB tx: mark `SUBMITTING` → `send()` → record `(txid, nonce/inputs)` → `SUBMITTED`.
- Track confirms; if `DROPPED/REPLACED` → regenerate item (same logical purpose), new `txid`, keep FIFO.

### Locking logic
- A lock sets once eligible deposits (by `blockTime ≤ expiresAt` and `confirms ≥ collectConfirms`) sum to threshold.  
- Locks are **monotonic** (once set, remain set).
## === BEACON::ENGINE::END ===

---

## === BEACON::RPC_API::START ===
**JSON-RPC 2.0** (HTTP POST `/rpc`)

### `otc.createDeal`
```ts
params: {
  alice: { chainId: ChainId, asset: AssetCode, amount: string },
  bob:   { chainId: ChainId, asset: AssetCode, amount: string },
  timeoutSeconds: number
}
result: { dealId: string, linkA: string, linkB: string }
Notes:
- Generates tokenA/tokenB for personal pages.
- Pre-compute commission **policy** (mode/currency) per side from plugin config,
  but DO NOT freeze native amount yet.
```

### `otc.fillPartyDetails`
```ts
params: {
  dealId: string,
  party: 'ALICE' | 'BOB',
  paybackAddress: string,
  recipientAddress: string,
  email?: string,
  token: string          // personal link token
}
result: { ok: true }

On first fill per party:
- Validate addresses via chain plugin.
- Create escrowA/escrowB accordingly.
- When BOTH parties filled:
  - COUNTDOWN start: set expiresAt = now + timeout
  - Freeze commission plan:
    - For PERCENT_BPS: compute amount; currency per config.
    - For FIXED_USD_NATIVE: call plugin.quoteNativeForUSD(usdFixed) → set nativeFixed + oracle.
  - Stage = 'COLLECTION'
```

### `otc.status`
```ts
params: { dealId: string }
result: {
  stage: DealStage,
  expiresAt?: string,
  // Escrow instructions for each side
  instructions: {
    sideA: Array<{ assetCode: string, amount: string, to: string }>,
    sideB: Array<{ assetCode: string, amount: string, to: string }>
  },
  // Locks & collected
  collection: {
    sideA: { trade: { required, collected, lockedAt? }, commission: { required, collected, lockedAt?, currency }},
    sideB: { ... }
  },
  // Queues snapshot
  queues: {
    swap: { pending: number, submitted: number, minConfirms: number | 'infinite' },
    refund: { pending: number, submitted: number, minConfirms: number | 'infinite' }
  },
  events: Array<{ t: string, msg: string }>
}
```

### `admin.setPrice` (optional manual oracle)
```ts
params: { chainId: ChainId, pair: string, price: string }
result: { ok: true, asOf: string }
Notes: Used when external oracle is unavailable.
```

**HTTP Pages**
- `GET /` — deal creation (calls `otc.createDeal`)
- `GET /d/:dealId/a/:token` — Alice page
- `GET /d/:dealId/b/:token` — Bob page
- Pages poll `/rpc` `otc.status` every ~5s.
## === BEACON::RPC_API::END ===

---

## === BEACON::FRONTEND::START ===
**Minimal UI (no heavy framework required):**
- Deal creation: select chain/asset/amount for both sides; timeout.
- Personal pages:
  - If not filled, show form (payback, recipient, email). Lock on submit.
  - Always show **two funding lines** when needed:
    - **Trade deposit**: `<expected> <asset>` to `<escrow address>` + QR
    - **Commission deposit** (if different): `<nativeFixed> <nativeSymbol>` to `<escrow address>` + “Quote frozen at <asOf>”
  - **Status panel**: Stage, time remaining, **Trade Lock** & **Commission Lock** per side with confirmed progress bars, queue minConfirms.

**UX rules**
- Explain that **trade amount is never reduced**; commission is **separate surplus**.
- Show operator address (read‑only) receiving commission per chain.
## === BEACON::FRONTEND::END ===

---

## === BEACON::CONFIG::START ===
**Env vars (example)**
```
PORT=8080
DB_PATH=./data/otc.db
LOG_LEVEL=info

# Chains
UNICITY_RPC=http://...
UNICITY_CONFIRMATIONS=6
UNICITY_COLLECT_CONFIRMS=6
UNICITY_OPERATOR_ADDRESS=...

ETH_RPC=http://localhost:8545
ETH_CONFIRMATIONS=3
ETH_COLLECT_CONFIRMS=3
ETH_OPERATOR_ADDRESS=0x...
ETH_FEEPAYER_KEYREF=feepayer_eth
ETH_COMMISSION_JSON={"ERC20:*":{"mode":"FIXED_USD_NATIVE","usdFixed":"10","currency":"NATIVE"},"ETH":{"mode":"PERCENT_BPS","percentBps":30,"currency":"ASSET"}}

POLYGON_RPC=...
POLYGON_CONFIRMATIONS=64
POLYGON_OPERATOR_ADDRESS=0x...
POLYGON_COMMISSION_JSON=...

SOLANA_RPC=...
SOLANA_CONFIRMATIONS=10
SOLANA_OPERATOR_ADDRESS=...

EMAIL_ENABLED=false
```

**better‑sqlite3 pragmas** applied at init: WAL, synchronous=NORMAL, busy_timeout=5000.

**Per‑deal parallelism**: engine uses **leases**; shard by dealId naturally.
## === BEACON::CONFIG::END ===

---

## === BEACON::TESTS::START ===
**Simulators** implement `ChainPlugin` with controls:
- Set `collectConfirms`, simulate reorg (drop N blocks), mempool eviction, gas failure, oracle freeze.

**E2E Matrix**
1. **Happy swap**: both sides hit trade+commission locks; plan executes; commissions paid to operator; residual refunds.  
2. **Timeout—only one side funded**: refunds only that side (per asset).  
3. **Near‑boundary**: deposit included before expiry, confirmed after → lock counts → swap proceeds.  
4. **Reorg before lock**: deposit falls below `collectConfirms` → lock not set; timeout refunds.  
5. **Deep reorg after initial observe** but before `collectConfirms`: still no lock until re‑confirmed.  
6. **Crash between send & persist**: idempotent submission; no nonce dup.  
7. **Unknown ERC‑20**: dual deposits (token + native commission). Swap only after both locks.  
8. **Gas budget**: ERC‑20 payout needs native top‑up; preflight enforces.  
9. **Late deposit after close**: auto‑refund in 7‑day window.  
10. **Rounding & dust**: commission floor; minSendable enforcement; final sweep.

**Unit tests**
- Commission freeze correctness.
- Lock computation (blockTime ≤ expiresAt).
- Queue ordering and per‑account FIFO.
- Lease acquisition semantics.
## === BEACON::TESTS::END ===

---

## === BEACON::PACKETS::START ===
**Task Packets v3 (paste to Claude in order or all at once):**

### Packet 0 — Scaffold & DB runtime
- Monorepo packages; TS config; ESLint+Prettier; Vitest.
- better‑sqlite3 setup with WAL pragmas; `Db.runTx`.

### Packet 1 — Core types & invariants
- Implement **TYPES** as above.
- Helpers: decimal math via `decimal.js`; asset metadata (decimals, minSendable, native symbol).

### Packet 2 — Chain plugin interface & Unicity adapter
- Implement **PLUGIN_IFACE**; create `UnicityPlugin` (native Alpha, percent commission from ALPHA surplus).
- Stubs for EVM & Solana (or simulators).

### Packet 3 — DAL & Migrations
- Create schema in **DB_SCHEMA**; repositories:
  - deals: create/get/update; stage transitions in tx
  - deposits: upsert (unique by txid,idx)
  - queues: enqueue (seq monotonic per `dealId+fromAddr`)
  - accounts: nonce/UTXO state
  - leases: acquire/refresh/release
  - events, notifications

### Packet 4 — JSON-RPC & HTTP pages
- Methods: `otc.createDeal`, `otc.fillPartyDetails`, `otc.status`, `admin.setPrice`.
- Implement token gating for personal pages via URL tokens.
- Minimal pages per **FRONTEND**.

### Packet 5 — Engine v3 (locks+plan+queues)
- 30s loop with **leases**.
- READ deposits; compute **trade** & **commission** locks (by blockTime & confirms).
- COUNTDOWN → freeze commission plan (quote native if needed).
- Preflight (native budget, gas estimation, nonce/UTXO reservation).
- Build **Transfer Plan** (SWAP_PAYOUT, OP_COMMISSION, SURPLUS_REFUND).
- FIFO queue submission; track confirms; handle reorgs; close.

### Packet 6 — EVM plugin (ETH/Polygon)
- Native & ERC‑20 deposits; `quoteNativeForUSD` (Chainlink or manual).
- ensureFeeBudget for token payouts; nonce manager; gas bumping.

### Packet 7 — Solana plugin (optional)
- SPL transfers, `SOL/USD` quote via Pyth or manual.

### Packet 8 — Notifications
- Idempotent notifier with in‑memory/console provider.

### Packet 9 — Simulators & E2E tests
- Implement scenarios in **TESTS**.

### Packet 10 — Hardening
- Address validation per plugin.
- Rate limiting; log redaction; encrypted keystore at rest.
## === BEACON::PACKETS::END ===

---

## === BEACON::EXAMPLES::START ===
**Example: Create → Fill → Status**
```json
// otc.createDeal
{"jsonrpc":"2.0","id":1,"method":"otc.createDeal","params":{
  "alice":{"chainId":"UNICITY","asset":"ALPHA@UNICITY","amount":"100.0"},
  "bob":{"chainId":"ETH","asset":"ERC20:0xRare","amount":"500.0"},
  "timeoutSeconds":3600
}}
```

```json
// otc.fillPartyDetails (Alice)
{"jsonrpc":"2.0","id":2,"method":"otc.fillPartyDetails","params":{
  "dealId":"<id>","party":"ALICE","paybackAddress":"<unicity_addr>",
  "recipientAddress":"<evm_addr>","email":"alice@example.com","token":"<tokenA>"
}}
```

```json
// otc.fillPartyDetails (Bob) → COUNTDOWN starts; freeze $10 in ETH
{"jsonrpc":"2.0","id":3,"method":"otc.fillPartyDetails","params":{
  "dealId":"<id>","party":"BOB","paybackAddress":"<evm_addr>",
  "recipientAddress":"<unicity_addr>","email":"bob@example.com","token":"<tokenB>"
}}
```

```json
// otc.status (fragment)
{
 "stage":"COLLECTION",
 "expiresAt":"2025-09-19T12:34:56Z",
 "instructions":{
   "sideA":[{"assetCode":"ALPHA@UNICITY","amount":"100.0","to":"<escrowA>"},
            {"assetCode":"ALPHA@UNICITY","amount":"0.30","to":"<escrowA>"}],
   "sideB":[{"assetCode":"ERC20:0xRare","amount":"500.0","to":"<escrowB>"},
            {"assetCode":"ETH","amount":"0.002858","to":"<escrowB>"}]
 },
 "collection":{
   "sideA":{"trade":{"required":"100.0","collected":"100.0","lockedAt":"..."},
            "commission":{"required":"0.30","collected":"0.31","lockedAt":"...","currency":"ASSET"}},
   "sideB":{"trade":{"required":"500.0","collected":"500.0","lockedAt":"..."},
            "commission":{"required":"0.002858","collected":"0.0030","lockedAt":"...","currency":"NATIVE"}}
 }
}
```
## === BEACON::EXAMPLES::END ===

---

## === BEACON::FAQ::START ===
- **Why freeze commission native amount?** To avoid price volatility changing requirements mid‑deal.  
- **What if oracle unavailable?** `fillPartyDetails` refuses to start COUNTDOWN; use `admin.setPrice` or wait.  
- **Can one side’s surplus pay both commissions?** Not by default. Set `allowCrossCoverCommission=true` only if business approves.  
- **Gas funding?** Prefer fee payer top‑ups; otherwise require native pre‑funding in preflight.  
- **Minimum sendables & dust?** Defined per asset; enforce in plan; sweep residuals if feasible.
## === BEACON::FAQ::END ===

---

### Final Notes
- This spec **supersedes** prior drafts.  
- The **Unicity Plugin is mandatory** in v1.  
- Implement **decimal math** via `decimal.js` only—no JS floats.  
- Preserve **idempotency** at every boundary (plan, submit, notify).

**End of BIGDOC v1.0**
