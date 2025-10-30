# Queue Performance Fix - Quick Reference

## Problem
🚨 **12 stuck queue items causing backend degradation**
- Cross-chain address mismatches (UNICITY chainId with EVM addresses)
- Queue processor stuck in infinite retry loop
- Causing high CPU usage and performance issues

## Solution (3 Commands)

```bash
# 1. Backup database (10 seconds)
./backup-database.sh

# 2. Apply fix (2 seconds)
node fix-queue-performance.js --yes

# 3. Restart backend (recommended)
npm run prod
```

## Verification

```bash
# Check results (should show 0 stuck items)
node analyze-queue-performance.js
```

## What Gets Fixed

✅ 12 cross-chain mismatched items → FAILED
✅ 4 old pending items (>24h) → FAILED
✅ Missing composite index → CREATED
✅ Queue processor → No longer stuck in retry loop

## Safety

- ✅ Backup created before changes
- ✅ Transaction-wrapped (rollback on error)
- ✅ Only affects invalid/stuck items
- ✅ Can restore from backup if needed

## Expected Results

| Metric | Before | After |
|--------|--------|-------|
| PENDING items | 16 | 0 |
| Cross-chain mismatches | 12 | 0 |
| Queue retries/day | ~1,152 | ~0 |
| Performance | Degraded | Normal |

## Rollback (if needed)

```bash
# Restore from backup
cp packages/backend/data/backups/otc-production.db.backup-TIMESTAMP \
   packages/backend/data/otc-production.db
npm run prod
```

## More Info

- **Executive Summary:** `QUEUE_PERFORMANCE_FIX_SUMMARY.md`
- **Full Analysis:** `DATABASE_PERFORMANCE_REPORT.md`
- **Analysis Tool:** `node analyze-queue-performance.js`
- **Fix Script:** `node fix-queue-performance.js --help`

---

**Risk:** LOW | **Impact:** HIGH | **Time:** 5 minutes
