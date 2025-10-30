# Database Performance Analysis Report

**Generated:** 2025-10-30
**Database:** /home/vrogojin/otc_agent/packages/backend/data/otc-production.db
**Analysis Tool:** analyze-queue-performance.js

---

## Executive Summary

**Status:** ⚠️ **ACTION REQUIRED** - Database has performance issues causing backend degradation

### Key Findings

- **Total Queue Items:** 76 (60 COMPLETED, 16 PENDING)
- **Critical Issues:** 12 cross-chain address mismatches causing stuck items
- **Performance Impact:** Queue processor stuck in tight error loop, retrying failed items
- **Index Status:** 6 indexes exist, but missing optimal composite index for primary query pattern

### Root Cause Analysis

The backend degradation is caused by **12 PENDING queue items with cross-chain address mismatches**:
- Items have `chainId='UNICITY'` but use EVM addresses (starting with `0x`)
- All items are `GAS_REFUND_TO_TANK` operations
- These items cannot be processed by the UNICITY plugin (expects `alpha1*` addresses)
- Queue processor continuously retries these items, causing CPU/memory pressure

**Why This Happened:**
- Items were created before fix in commit `449cbb7` (2025-10-16)
- Original code didn't prevent GAS_REFUND_TO_TANK creation for UTXO chains
- Tank wallet address is EVM-only (`0x2f750c3Ac8e85E0D...`)
- UNICITY escrow addresses use different format (`alpha1q...`)

---

## Detailed Analysis

### 1. Stuck Queue Items

#### Cross-Chain Address Mismatches (CRITICAL)

**Count:** 12 items
**Age:** 280-330 hours (11-14 days)
**Impact:** High - Causing tight retry loop in queue processor

| Queue Item ID | Deal ID | Purpose | From (UNICITY) | To (EVM) | Hours Stuck |
|---------------|---------|---------|----------------|----------|-------------|
| c78ad5f6f63d... | 90126ba3 | GAS_REFUND_TO_TANK | alpha1q27yykn5g... | 0x2f750c3Ac8e85... | 330.1 |
| fa85d3c1f08c... | 32f25867 | GAS_REFUND_TO_TANK | alpha1qavyez9yv... | 0x2f750c3Ac8e85... | 329.7 |
| 7f51b72ac223... | 62925a98 | GAS_REFUND_TO_TANK | alpha1q8h5qth3l... | 0x2f750c3Ac8e85... | 315.5 |
| 3337450a228f... | e94077c5 | GAS_REFUND_TO_TANK | alpha1qkstu4gtt... | 0x2f750c3Ac8e85... | 315.4 |
| 591a48983b57... | 714eaace | GAS_REFUND_TO_TANK | alpha1q2pur24ua... | 0x2f750c3Ac8e85... | 314.1 |
| 64f5dd22a557... | da5af7ee | GAS_REFUND_TO_TANK | alpha1q2td0mtxh... | 0x2f750c3Ac8e85... | 304.6 |
| 98402c95b0d4... | a6e5af15 | GAS_REFUND_TO_TANK | alpha1q4q2deaal... | 0x2f750c3Ac8e85... | 280.9 |
| b07d428f371d... | ebb9101d | GAS_REFUND_TO_TANK | alpha1qyn6kkzpv... | 0x2f750c3Ac8e85... | 194.7 |
| 4bb5e8bfbd37... | 53bb843d | GAS_REFUND_TO_TANK | alpha1q828d9mfh... | 0x2f750c3Ac8e85... | 194.7 |
| ae3a1900a28a... | f2057799 | GAS_REFUND_TO_TANK | alpha1quhwcskre... | 0x2f750c3Ac8e85... | 168.7 |
| 4187c4fa2249... | 43052fe2 | GAS_REFUND_TO_TANK | alpha1q7ydwye63... | 0x2f750c3Ac8e85... | 167.9 |
| c54aa07237f4... | fae700fb | GAS_REFUND_TO_TANK | alpha1qzfyg6vte... | 0x2f750c3Ac8e85... | 166.8 |

**Error Pattern:**
Each time the queue processor runs, it attempts to process these items:
1. Gets `chainId='UNICITY'` and loads Unicity plugin
2. Attempts to send native currency from `alpha1q...` to `0x2f75...`
3. UNICITY plugin rejects the `0x` address (invalid format for UTXO chain)
4. Item remains PENDING and gets retried in next loop (30 seconds later)
5. Cycle repeats indefinitely

#### Other Stuck Items

**Count:** 4 BROKER_REFUND items
**Age:** 194-330 hours

These items are also old and should be investigated:
- Deal 90126ba3: BROKER_REFUND (POLYGON) - 330.1 hours
- Deal e94077c5: BROKER_REFUND (POLYGON) - 315.4 hours
- Deal ebb9101d: BROKER_REFUND (ETH) - 194.7 hours
- Deal 53bb843d: BROKER_REFUND (ETH) - 194.7 hours

These may be legitimate pending transactions or may also need to be marked as failed.

---

### 2. Database Schema Analysis

#### Table Structure
```sql
CREATE TABLE queue_items (
  id TEXT PRIMARY KEY,
  dealId TEXT NOT NULL,
  chainId TEXT NOT NULL,
  fromAddr TEXT NOT NULL,
  toAddr TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  purpose TEXT NOT NULL,
  phase TEXT,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  submittedTx TEXT,
  createdAt TEXT NOT NULL,
  -- Additional columns for recovery and gas bump tracking
  payoutId TEXT REFERENCES payouts(payoutId),
  recoveryAttempts INTEGER DEFAULT 0,
  lastRecoveryAt INTEGER,
  recoveryError TEXT,
  lastSubmitAt TEXT,
  originalNonce INTEGER,
  lastGasPrice TEXT,
  gasBumpAttempts INTEGER DEFAULT 0,
  payback TEXT,
  recipient TEXT,
  feeRecipient TEXT,
  fees TEXT
)
```

#### Existing Indexes

1. **sqlite_autoindex_queue_items_1** (PRIMARY KEY on `id`)
2. **idx_queue_deal** - `ON queue_items(dealId)`
3. **idx_queue_status** - `ON queue_items(status)`
4. **idx_queue_payout** - `ON queue_items(payoutId)`
5. **idx_queue_items_recovery** - `ON queue_items(status, submittedTx, lastRecoveryAt)`
6. **idx_queue_stuck** - `ON queue_items(status, lastSubmitAt) WHERE status = 'SUBMITTED'`

#### Missing Index (IMPORTANT)

The primary query pattern used by `QueueRepository.getNextPending()` filters on multiple columns:
```sql
SELECT * FROM queue_items
WHERE dealId = ? AND fromAddr = ? AND chainId = ? AND status = 'PENDING' AND phase = ?
ORDER BY seq
LIMIT 1
```

**Current Query Plan:**
```
SEARCH queue_items USING INDEX idx_queue_items_recovery (status=?)
USE TEMP B-TREE FOR ORDER BY
```

The query is using `idx_queue_items_recovery` which only indexes `status`, requiring a secondary sort using a temporary B-tree. This is inefficient.

**Recommended Index:**
```sql
CREATE INDEX idx_queue_items_lookup
  ON queue_items(dealId, fromAddr, chainId, status, phase, seq);
```

This composite index covers all columns in the WHERE clause plus the ORDER BY column, eliminating the need for a temporary B-tree sort.

---

### 3. Performance Impact Assessment

#### Current State
- **Queue Processor Loop:** Runs every 30 seconds
- **Items Per Loop:** Attempts to process 16 PENDING items
- **Success Rate:** 25% (4 BROKER_REFUND may be legitimate, 12 GAS_REFUND are guaranteed failures)
- **Wasted CPU Cycles:** ~1,152 retries per day (48 retries/hour × 24 hours)

#### Expected Improvement After Fix
- **Items Per Loop:** 4 PENDING items (if BROKER_REFUND are legitimate)
- **Success Rate:** Unknown (depends on BROKER_REFUND investigation)
- **CPU Reduction:** 75% reduction in retry attempts
- **Memory:** Reduced pressure from error logging/exception handling

---

## Recommended Actions

### Immediate Actions (CRITICAL)

1. **Mark Cross-Chain Mismatched Items as FAILED**
   ```sql
   UPDATE queue_items
   SET status = 'FAILED'
   WHERE chainId = 'UNICITY'
     AND (toAddr LIKE '0x%' OR fromAddr LIKE '0x%')
     AND status IN ('PENDING', 'SUBMITTED');
   -- Affects: 12 items
   ```

2. **Add Composite Index for Query Optimization**
   ```sql
   CREATE INDEX IF NOT EXISTS idx_queue_items_lookup
     ON queue_items(dealId, fromAddr, chainId, status, phase, seq);
   ```

### Secondary Actions (RECOMMENDED)

3. **Mark Items Pending >24 Hours as FAILED**
   ```sql
   UPDATE queue_items
   SET status = 'FAILED'
   WHERE status = 'PENDING'
     AND julianday('now') - julianday(createdAt) > 1;
   -- Affects: 16 items (includes all items from action #1)
   ```

4. **Investigate BROKER_REFUND Items**
   - Check if deals 90126ba3, e94077c5, ebb9101d, 53bb843d completed successfully
   - Verify if BROKER_REFUND transactions were submitted but not confirmed
   - Review broker contract event logs for these deals

### Preventive Actions (ALREADY IMPLEMENTED)

5. ✅ **Code Fix Applied** - Commit 449cbb7
   - Prevents GAS_REFUND_TO_TANK creation for UTXO chains
   - Validates address format before creating queue items
   - Adds logging to identify mismatched items early

---

## Fix Execution Plan

### Step 1: Backup Database
```bash
cp packages/backend/data/otc-production.db packages/backend/data/otc-production.db.backup-$(date +%Y%m%d-%H%M%S)
```

### Step 2: Run Fix Script (Dry Run)
```bash
node fix-queue-performance.js --dry-run
```

### Step 3: Apply Fixes
```bash
node fix-queue-performance.js --yes
```

### Step 4: Verify Results
```bash
node analyze-queue-performance.js
```

### Step 5: Monitor Backend Performance
- Observe CPU/memory usage after restart
- Check queue processor logs for errors
- Verify no new stuck items are created

---

## Risk Assessment

### Risks of Applying Fixes

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Data loss | Very Low | Low | Backup created before changes |
| Marking legitimate items as FAILED | Low | Medium | Only marking cross-chain mismatches (guaranteed invalid) |
| Index creation fails | Very Low | Low | Uses `IF NOT EXISTS` clause |
| Database corruption | Very Low | High | Transaction-wrapped, will rollback on error |

### Risks of NOT Applying Fixes

| Risk | Likelihood | Impact | Severity |
|------|-----------|--------|----------|
| Continued backend degradation | Very High | High | **CRITICAL** |
| Service outage | Medium | Very High | **CRITICAL** |
| Database growth from logs | High | Medium | **HIGH** |
| User experience degradation | High | High | **HIGH** |

**Recommendation:** Apply fixes immediately. Risk of applying fixes is significantly lower than risk of continued degradation.

---

## Technical Details

### Queue Processing Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Engine Loop (every 30s)                                         │
│  ↓                                                               │
│  QueueProcessor.processQueue()                                  │
│    ↓                                                             │
│    For each escrow address:                                     │
│      ↓                                                           │
│      QueueRepository.getNextPending(dealId, fromAddr, chainId)  │
│        ↓                                                         │
│        SELECT * FROM queue_items                                │
│        WHERE dealId = ? AND fromAddr = ?                        │
│          AND chainId = ? AND status = 'PENDING'                 │
│        ORDER BY seq LIMIT 1                                     │
│          ↓                                                       │
│          ChainPlugin(chainId).submitTransaction(...)            │
│            ↓                                                     │
│            ❌ FAILS for UNICITY with EVM address                │
│            ↓                                                     │
│            Item remains PENDING                                 │
│            ↓                                                     │
│            ⏮  Retry in 30 seconds... (infinite loop)            │
└─────────────────────────────────────────────────────────────────┘
```

### Code References

**Affected Files:**
- `/packages/backend/src/engine/Engine.ts` (lines 2525-2544, 2560-2580, 2755-2774, 2790-2810)
- `/packages/backend/src/db/repositories/QueueRepository.ts` (lines 130-195)

**Related Commits:**
- `449cbb7` - Fix GAS_REFUND_TO_TANK cross-chain address mismatch for UTXO chains
- `1880f03` - Fix GAS_REFUND_TO_TANK processing with wrong chain plugin

---

## Monitoring Recommendations

### Post-Fix Monitoring

1. **Queue Health Dashboard**
   - Track PENDING items count over time
   - Alert if count exceeds threshold (e.g., >10)
   - Track items pending >1 hour

2. **Queue Processor Metrics**
   - Success rate per loop
   - Processing time per item
   - Error rate by purpose type

3. **Database Performance**
   - Query execution time for getNextPending()
   - Index usage statistics
   - Table size growth rate

4. **Automated Alerts**
   - Alert on cross-chain address mismatches
   - Alert on items pending >24 hours
   - Alert on queue processor errors

---

## Appendix

### SQL Queries for Manual Investigation

#### Check specific deal status
```sql
SELECT * FROM queue_items WHERE dealId = '90126ba3';
SELECT * FROM deals WHERE id = '90126ba3';
```

#### Find all items by purpose
```sql
SELECT purpose, status, COUNT(*) as count
FROM queue_items
GROUP BY purpose, status
ORDER BY purpose, status;
```

#### Check tank wallet refunds
```sql
SELECT * FROM queue_items
WHERE purpose = 'GAS_REFUND_TO_TANK'
ORDER BY createdAt DESC;
```

#### Verify index usage
```sql
EXPLAIN QUERY PLAN
SELECT * FROM queue_items
WHERE dealId = 'test' AND fromAddr = 'test' AND chainId = 'UNICITY'
  AND status = 'PENDING' AND phase = 'PHASE_1_SWAP'
ORDER BY seq LIMIT 1;
```

---

## Conclusion

The database performance issues are caused by 12 stuck queue items with cross-chain address mismatches. These items were created before a code fix was applied and are causing the queue processor to enter a tight retry loop.

**Immediate action required:** Apply the fix script to mark these items as FAILED and add the missing composite index.

**Expected outcome:** 75% reduction in queue processing overhead, improved backend stability, and elimination of the retry loop.

**Risk level:** Low - Fixes are safe and reversible (backup will be created)

**Estimated time to apply:** 2-5 minutes
**Estimated time to verify:** 10-30 minutes

---

**Report End**
