# Internal Transaction Retry Mechanism

## Overview
This document describes the retry mechanism for fetching internal transactions from Etherscan API, which has a significant indexing delay after transaction confirmation.

## Problem Statement
- Etherscan API doesn't immediately index internal transactions after a transaction is confirmed
- The backend queries for internal transactions immediately after confirmation and gets an empty result
- This empty result is returned to the GUI, showing transactions as "unknown"
- Users have to manually refresh to see internal transactions later

## Solution: In-Memory Cache with Retry

### Architecture
The solution implements an in-memory cache with automatic retry logic:

1. **Cache Structure**: `Map<string, InternalTxRetryState>` where the key is `${chainId}:${txid}`
2. **Background Worker**: Runs every 60 seconds to retry pending fetches
3. **Exponential Backoff**: Retry intervals of 30s, 1m, 2m, 5m, 10m
4. **Max Retry Duration**: Stops retrying after 15 minutes

### Components

#### InternalTxRetryState Interface
```typescript
interface InternalTxRetryState {
  txid: string;
  chainId: string;
  firstAttempt: number;  // Timestamp of first attempt
  lastAttempt: number;   // Timestamp of last attempt
  retryCount: number;    // Number of retries
  nextRetryAt: number;   // When to retry next (timestamp)
  isPending: boolean;    // Whether retry is still pending
  result?: any[];        // Cached successful result
}
```

#### Key Methods
- `startRetryWorker()`: Initializes the background worker that processes the retry queue
- `processRetryQueue()`: Attempts to fetch internal transactions for all pending items
- `getOrCreateRetryState()`: Creates or retrieves retry state for a transaction
- `isRecentTransaction()`: Checks if a transaction is < 10 minutes old

### Workflow

1. **Initial Request**: When `otc.status` is called:
   - First checks the cache for existing results
   - If not cached, calls the plugin's `getInternalTransactions()`
   - If empty and transaction is recent (< 10 minutes), schedules retry

2. **Retry Process**: Background worker runs every 60 seconds:
   - Finds all pending retries where `nextRetryAt` has passed
   - Attempts to fetch internal transactions for each
   - If successful, caches the result and marks as complete
   - If still empty, schedules next retry with exponential backoff
   - Stops retrying after 15 minutes

3. **Response Enhancement**: The RPC response includes:
   - `internalTransactions`: Array of internal transactions (if available)
   - `internalTxPending`: Boolean indicating retry is in progress
   - `internalTxRetryInfo`: Object with retry count and next retry time
   - `internalTxCached`: Boolean indicating result came from cache

### Configuration
```typescript
private readonly RETRY_INTERVALS = [30000, 60000, 120000, 300000, 600000]; // 30s, 1m, 2m, 5m, 10m
private readonly MAX_RETRY_AGE = 900000; // 15 minutes
private readonly RETRY_WORKER_INTERVAL = 60000; // Check every 60 seconds
```

## Benefits

1. **Automatic Recovery**: No manual refresh needed - system automatically retries
2. **Efficient Caching**: Successful results are cached and reused
3. **User Feedback**: GUI can show "pending" status while retrying
4. **Resource Efficient**: Exponential backoff prevents excessive API calls
5. **Graceful Degradation**: Stops retrying after 15 minutes to avoid infinite loops

## Example Response

### While Retrying
```json
{
  "transactions": [{
    "txid": "0x123...",
    "purpose": "BROKER_SWAP",
    "internalTxPending": true,
    "internalTxRetryInfo": {
      "retryCount": 2,
      "nextRetryIn": 45000
    }
  }]
}
```

### After Successful Retry
```json
{
  "transactions": [{
    "txid": "0x123...",
    "purpose": "BROKER_SWAP",
    "internalTransactions": [
      {
        "from": "0xbroker",
        "to": "0xalice",
        "value": "1000000000000000000",
        "type": "call"
      },
      {
        "from": "0xbroker",
        "to": "0xbob",
        "value": "2000000000000000000",
        "type": "call"
      }
    ],
    "internalTxCached": true
  }]
}
```

## Testing

A test file is provided at `/packages/backend/test/internal-tx-retry.test.ts` that verifies:
1. Retry state creation for empty results
2. Background worker processing
3. Successful result caching
4. Cache reuse for subsequent requests

Run tests with:
```bash
npx tsx packages/backend/test/internal-tx-retry.test.ts
```

## Future Enhancements

### Option 2: Database-Backed Cache
For production environments that need persistence across restarts:

1. Create `internal_tx_cache` table:
```sql
CREATE TABLE internal_tx_cache (
  chainId TEXT NOT NULL,
  txid TEXT NOT NULL,
  firstAttempt INTEGER NOT NULL,
  lastAttempt INTEGER NOT NULL,
  retryCount INTEGER NOT NULL DEFAULT 0,
  nextRetryAt INTEGER NOT NULL,
  isPending INTEGER NOT NULL DEFAULT 1,
  result TEXT,
  PRIMARY KEY (chainId, txid)
);
```

2. Modify retry worker to query/update database
3. Add cleanup job to remove old entries

This would provide:
- Persistence across server restarts
- Shared cache across multiple server instances
- Audit trail of retry attempts