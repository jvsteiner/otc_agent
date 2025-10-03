# OTC Gas Management Integration Tasks (Ethereum + Polygon)

This document is a **task breakdown** for integrating gas management ("tank" model) into the existing OTC broker service. It targets **Ethereum** and **Polygon** first, and assumes the current broker only supports swaps of **native currencies**. The end‑state lets the service pay gas in **ETH/MATIC** out of a managed **tank wallet**, while pulling **ERC‑20 stablecoins (USDC/USDT/EURC)** from per‑session escrow addresses via **gasless authorizations** (permit/Permit2/3009) and performing automated swaps to keep the tank funded.

> Audience: Claude agent & engineers implementing backend adapters, treasury, and orchestration.

---

## 0) Goals & Non‑Goals

### Goals
- Gasless UX for escrow addresses: **no ETH/MATIC pre‑funding**.
- Centralized **tank** per chain that:
  - pays for gas (ETH for Ethereum, MATIC for Polygon),
  - can **pull** stablecoins from escrow using off‑chain authorizations (when supported),
  - periodically swaps stablecoins → native to maintain thresholds.
- Deterministic **payout pipeline**: distribute to counterparty, OTC fee, tank top‑up, and residual refund.
- Production‑grade **observability**, **rate‑limiting**, **RBF** (replace‑by‑fee) and **retries**.

### Non‑Goals (for this phase)
- ERC‑4337 Paymaster integration (future enhancement).
- Support for non‑EVM chains beyond Solana (to be handled later).
- UI changes (backend first).

---

## 1) High‑Level Architecture

**Modules**
1. **ChainAdapter(EVM)**: Ethereum / Polygon specific logic (ethers v6/viem).
2. **TankTreasury**: multi‑chain treasury accounts; native balance management; swap engine.
3. **EscrowManager**: escrow lifecycle; capability detection (permit/3009/Permit2); generation of authorizations.
4. **PayoutOrchestrator**: atomic payout job that executes full distribution plan.
5. **Quotes & Oracles**: gas price sources + DEX quotes (Uniswap Quoter/Router); safety margins.
6. **Scheduler**: periodic checks for tank thresholds, time‑based swaps, dust sweeps.
7. **Risk & Policy**: spend limits, allowlists, compliance checks.
8. **Observability**: metrics, structured logs, alerts, dashboards.
9. **Config & Secrets**: chain params, token lists, slippage/fees, HSM/MPC keys.

**Key Design Tenets**
- **Permit‑first**: prefer EIP‑2612 `permit`, EIP‑3009 `transferWithAuthorization`, or Uniswap **Permit2 one‑time** signature; fallback to one‑time `approve` if unavoidable.
- **Single‑submit** TX on EVM: when possible, combine `permit` + transfers in one transaction from the **tank**.
- **Deterministic math** for how many stablecoins to route to tank vs. counterparties.

---

## 2) Workstreams & Detailed Tasks

### 2.1 Escrow Authorizations (Gasless Pull)
**Objective:** Allow tank to move stablecoins from escrow **without** escrow holding ETH/MATIC.

**Tasks**
- [ ] Implement **capability detection** per token/chain at runtime:
  - Try `permit` (EIP‑2612): check `DOMAIN_SEPARATOR`, `nonces(address)` and `permit(owner,spender,value,deadline,v,r,s)`.
  - Try **EIP‑3009**: `transferWithAuthorization` / `receiveWithAuthorization` support.
  - Implement **Permit2** one‑time approval flow (does not require token‑native permit), with signer producing a permit for exact amount + deadline.
  - If none available → mark token **requires one‑time approve** (and route through **meta‑tx** or micro‑top‑up strategy; see fallback section).
- [ ] Build **Signer Service** to produce EIP‑712 payloads for `permit` and Permit2; validate chainId, name, version, and deadline.
- [ ] Add **EscrowAuth API**:
  - `POST /escrow/:id/authorize` → returns typed‑data JSON to sign for the session.
  - `POST /escrow/:id/submit-signature` → verifies signature, stores intent, enqueues payout.
- [ ] Unit tests for all auth variants; fuzz tests for invalid domain separators, bad deadlines, replay protection.

**Acceptance Criteria**
- Given a supported token, tank can **pull** funds from escrow using only escrow’s **off‑chain signature**.
- Recorded on‑chain TX uses **single submit** path whenever permit is supported.

---

### 2.2 Tank & Treasury
**Objective:** Manage native balances (ETH/MATIC), track stablecoin inflows, and provide spend primitives.

**Tasks**
- [ ] Define **Tank account** per chain (address, key policy, spend limits, RBF policy).
- [ ] Implement `TankTreasury` methods:
  - `getNativeBalance(chain)`
  - `ensureNativeThreshold(chain)`
  - `pullFromEscrow(escrow, token, amount, auth)`
  - `payCounterparty(token, to, amount)`
  - `payOperatorFee(token, amount)`
  - `transferToTank(token, amount)` (no‑op if already in tank)
  - `swapToNative(token, minOut, deadline)`
- [ ] Add **HSM/MPC** integration for tank keys; enforce per‑tx and per‑period spend limits.
- [ ] Dust **sweep** utilities to consolidate residual ETH/MATIC across helper addresses back into tank.

**Acceptance Criteria**
- Threshold policy keeps native balance above **configured low‑watermark**.
- All movements are idempotent and traceable with ledger entries.

---

### 2.3 Quotes & Gas Estimation
**Objective:** Price payouts and tank replenishment in stablecoins with safety margins.

**Tasks**
- [ ] Implement **Gas Oracle** abstraction:
  - Ethereum: use `eth_feeHistory` + p95 priority with multiplier.
  - Polygon: integrate a **Gas Station** style source; fallback to on‑chain `baseFee` + priority heuristic.
- [ ] Implement **DEX Quote** abstraction:
  - Uniswap **Quoter** for spot quotes token↔native; support multi‑hop if needed.
  - Configurable **slippage** and **minOut** calculation.
- [ ] Build `estimateNativeNeed(txPlan)` → gasUnits × (baseFee + priority) × **safetyMargin**.
- [ ] Build `stableNeededForNative(nativeAmount)` via Quoter.
- [ ] Add **markups** (service fee, volatility buffer) and produce a **Breakdown** object.

**Acceptance Criteria**
- For a given payout plan, system returns **deterministic** stablecoin amounts to collect and route to tank with ± tolerance.

---

### 2.4 Payout Orchestrator (Happy Path)
**Objective:** Execute a full payout in one coherent job.

**Tasks**
- [ ] Input: `PayoutIntent { escrowId, token, amounts: {counterparty, operatorFee, tankTopUp, refund}, authSig, deadlines }`.
- [ ] Validate signature freshness and amounts sum.
- [ ] Compose **single EVM transaction** from tank when possible:
  1) `permit`/Permit2 consume authorization,
  2) `transfer` to counterparty,
  3) `transfer` operator fee,
  4) `transfer` tank top‑up,
  5) optional `refund`.
- [ ] Broadcast with **EIP‑1559** params; store tx hash; implement **RBF** if pending too long.
- [ ] Confirmations watcher → finalize intent; persist on‑chain receipts & logs.

**Acceptance Criteria**
- One job → one or minimal set of on‑chain transactions with correct post‑balances.

---

### 2.5 Scheduler: Swaps & Thresholds
**Objective:** Convert collected stablecoins to native periodically or on thresholds.

**Tasks**
- [ ] Policies:
  - **Amount‑based**: when stable bucket ≥ X.
  - **Time‑based**: every N minutes.
  - **Low‑native**: when native balance < low‑watermark.
- [ ] Implement `buildSwapRoute(token→native)` using Uniswap Router; respect max slippage and deadline.
- [ ] Execute, record **effective rate**, slippage, and fees.

**Acceptance Criteria**
- Native balance maintained; swaps occur within configured guardrails and are fully auditable.

---

### 2.6 Fallbacks & Edge Cases
**Objective:** Ensure continuity when tokens lack permit or quotes fail.

**Tasks**
- [ ] If token lacks permit/3009 → attempt **Permit2 one‑time**; if unsupported in context → use **micro‑top‑up** (send tiny ETH/MATIC to escrow) to allow a single `approve`, then proceed.
- [ ] Meta‑tx fallback: broker‑relayer pays gas; commit accounting off‑chain; reconcile with next tank top‑up.
- [ ] Quote failures: pause payout or use **circuit breaker** with wider slippage; alert ops.
- [ ] Nonce conflicts / stuck tx: implement RBF ladder and auto‑cancel after deadline.

**Acceptance Criteria**
- Documented and tested fallbacks ensure no dead‑ends.

---

### 2.7 Risk, Limits, Compliance
**Tasks**
- [ ] Per‑session and per‑address spend ceilings; rolling windows (1h/24h).
- [ ] Allowlist/denylist enforcement before authorizing payouts.
- [ ] Deadlines and min validity windows for signatures.
- [ ] Multi‑sig or approval workflow for large swaps/transfers.

**Acceptance Criteria**
- Violations are blocked; alerts raised; audit trail recorded.

---

### 2.8 Observability & SRE
**Tasks**
- [ ] **Metrics**: time‑to‑confirm, success rate, RBF count, gas/unit, swap slippage, on‑chain reverts.
- [ ] **Logs**: structured JSON with correlation IDs per session/tx.
- [ ] **Alerts**: low native balance, high pending age, oracle divergence, swap slippage > threshold.
- [ ] **Dashboards**: tank balances, flow volumes, error rates, queue depth.

**Acceptance Criteria**
- On‑call can detect problems in <5 minutes and has playbooks.

---

## 3) Public API (Broker Backend)

### 3.1 Endpoints
- `POST /sessions` → create escrow session; returns `escrowId`, addresses by chain.
- `POST /sessions/:id/authorize` → returns typed‑data for permit/Permit2/3009.
- `POST /sessions/:id/signature` → submit signature; server validates and stores.
- `POST /sessions/:id/payout` → body includes recipient(s), amounts, token, desired deadlines.
- `GET /sessions/:id/status` → lifecycle state, tx hashes, receipts.
- `GET /treasury/:chain/balances` → native & token balances, thresholds.
- `POST /treasury/:chain/swap` → trigger swap (admin), with safeguards.

### 3.2 Events (Webhooks / Kafka topics)
- `payout.requested`, `payout.submitted`, `payout.broadcast`, `payout.confirmed`, `payout.failed`.
- `treasury.threshold.low`, `treasury.swap.executed`, `treasury.swap.failed`.

### 3.3 Error Model
```json
{
  "code": "TX_STUCK|INSUFFICIENT_AUTH|QUOTE_EXPIRED|SLIPPAGE_TOO_HIGH|LIMIT_EXCEEDED",
  "message": "human readable",
  "data": { "txHash": "…", "details": {} }
}
```

---

## 4) Internal Interfaces (Pseudocode)

### 4.1 Quotes
```ts
interface GasQuote {
  chain: "ethereum" | "polygon";
  baseFee: bigint;            // wei
  priorityFee: bigint;        // wei
  suggestedMaxFee: bigint;    // wei (policy)
}

interface DexQuote {
  tokenIn: Address; tokenOut: Address;
  amountIn: bigint; amountOut: bigint;  // minOut after slippage
  route: Route; deadline: number;
}
```

### 4.2 Orchestrator
```ts
async function executePayout(intent: PayoutIntent): Promise<TxResult> {
  const gas = await gasOracle.quote(intent.chain);
  const nativeNeed = estimateNativeNeed(intent.txPlan, gas);
  const stableForGas = await dex.stableNeededForNative(intent.token, nativeNeed);
  const breakdown = addMarkupAndFees(stableForGas, intent);

  const call = composeSingleTx({
    permitSig: intent.authSig,
    transfers: [
      {to: intent.counterparty, amount: intent.amounts.counterparty},
      {to: config.operatorAddr, amount: intent.amounts.operatorFee},
      {to: tank.addr, amount: breakdown.tankTopUp},
      ...(intent.amounts.refund > 0 ? [{to: intent.payer, amount: intent.amounts.refund}] : [])
    ]
  });

  return await evm.broadcast(call, withEip1559(gas));
}
```

---

## 5) Data Model (DB)

**Tables**
- `escrow_sessions(id, chain, owner, token, created_at, status)`
- `escrow_auth(id, session_id, type, payload_json, signature, deadline, used_at)`
- `payout_intents(id, session_id, token, amounts_json, state, tx_hash, created_at, confirmed_at)`
- `tank_balances(id, chain, native, stable_json, updated_at)`
- `swap_executions(id, chain, token_in, token_out, amount_in, amount_out, rate, slippage, tx_hash, created_at)`
- `limits(chain, key, window, max_amount)`
- `alerts(id, type, severity, payload_json, created_at, resolved_at)`

---

## 6) Configuration

- **Per‑Chain**: RPCs, chainId, native ticker, token list (addresses/decimals), gas multipliers, priority fee policy.
- **DEX**: router/quoter addresses, preferred pools, slippage bps, deadlines.
- **Risk**: per‑session caps, per‑day caps, allowlist toggles.
- **Scheduler**: time‑based cadence, amount thresholds, low‑native thresholds.

---

## 7) Security Checklist

- [ ] Keys in **HSM/MPC**; no raw keys on disk; role separation (fee payer vs asset operator).
- [ ] Spend limits per tx/hour/day; admin break‑glass with audit.
- [ ] Signatures: strict domain data (chainId, name, version), short deadlines, nonce tracking.
- [ ] Permit2: restrict to one‑time amount; do **not** grant infinite approvals by default.
- [ ] RBF guardrails: max replacements, max fee caps to avoid griefing.
- [ ] Webhook signing & idempotency keys everywhere.

---

## 8) Test Plan

**Unit**
- Permit/3009/Permit2 encoding & verification.
- Gas math; DEX quote math; slippage enforcement.
- RBF ladder logic.

**Integration (Testnets)**
- Happy‑path single‑submit on Goerli/Sepolia + Polygon testnet.
- Fallback path: no‑permit token → one‑time top‑up → approve → payout.
- Swap routes, minOut enforcement, deadline expiry.

**Chaos & Edge Cases**
- Oracle divergence; high baseFee spikes; mempool congestion.
- Nonce collisions; partial reorgs (re‑org depth ≤ 3).
- Quoter returns stale/zero; circuit breaker triggers.

**Acceptance**
- End‑to‑end scenario confirms balances and ledger entries match spec within tolerance.

---

## 9) Rollout Plan

1. **Feature flag** by chain and token.
2. Start with **USDC** (best tooling), then **EURC**, then **USDT**.
3. Shadow mode: compute‑only quotes & intents → compare to real costs.
4. Limited GA for high‑trust counterparties; expand after burn‑in.

---

## 10) Playbooks (Ops)

- **TX stuck**: after X blocks, bump priority by Y gwei; after N attempts → alert & manual review.
- **Low native balance**: pause new payouts; trigger emergency swaps; notify on‑call.
- **Quote failure**: switch to fallback source; if 2 sources fail → hold payouts.

---

## 11) Deliverables (for this milestone)

- ✅ Chain adapters (Ethereum, Polygon) with broadcast & RBF.
- ✅ Escrow authorization flows: permit, 3009, Permit2 (one‑time), fallback top‑up.
- ✅ Orchestrator with single‑submit payout TX.
- ✅ Tank treasury with threshold policy and swap scheduler.
- ✅ Public API & event schema; DB migrations.
- ✅ Metrics, logs, alerts, dashboards; SRE runbooks.
- ✅ Test coverage and testnet demo scripts.

---

## 12) Open Questions / To Decide

- Permit2 strategy: one‑time only vs limited recurring; policy defaults.
- Which tokens **do not** support permit/3009 on our target networks (auto‑detect vs hard‑list)?
- Swap venues preference and MEV mitigation (e.g., private tx to RPC, maxFee caps).
- Exact markup formula for volatility buffer.

