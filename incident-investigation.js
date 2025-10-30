#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'packages/backend/data/otc-production.db');
console.log(`Opening database: ${dbPath}\n`);

try {
  const db = new Database(dbPath, { readonly: true });

  console.log("=== 1. QUEUE ITEMS STATUS DISTRIBUTION ===");
  const statusDist = db.prepare(`
    SELECT status, COUNT(*) as total, COUNT(DISTINCT dealId) as unique_deals
    FROM queue_items
    GROUP BY status
  `).all();
  console.table(statusDist);

  console.log("\n=== 2. ALL PENDING QUEUE ITEMS ===");
  const pending = db.prepare(`
    SELECT id, dealId, chainId, purpose,
           SUBSTR(fromAddr, 1, 20) as from_addr,
           SUBSTR(toAddr, 1, 20) as to_addr,
           asset, amount,
           phase, seq, status,
           recoveryAttempts, recoveryError,
           lastSubmitAt
    FROM queue_items
    WHERE status = 'PENDING'
    ORDER BY createdAt DESC
  `).all();
  console.table(pending);
  console.log(`Total PENDING items: ${pending.length}`);

  console.log("\n=== 3. KNOWN STUCK ITEM c54aa07237f499f9af1941cc63129320 ===");
  const stuckItem = db.prepare(`
    SELECT * FROM queue_items WHERE id = ?
  `).get('c54aa07237f499f9af1941cc63129320');
  if (stuckItem) {
    console.log(JSON.stringify(stuckItem, null, 2));
  } else {
    console.log("NOT FOUND - checking partial match...");
    const partial = db.prepare(`
      SELECT id, dealId, chainId, purpose, status
      FROM queue_items 
      WHERE id LIKE ?
    `).all('%c54aa072%');
    console.table(partial);
  }

  console.log("\n=== 4. ERROR PATTERNS (Recovery Errors) ===");
  const errorPatterns = db.prepare(`
    SELECT COUNT(*) as error_count,
           recoveryError
    FROM queue_items
    WHERE recoveryError IS NOT NULL
    GROUP BY recoveryError
    ORDER BY error_count DESC
    LIMIT 15
  `).all();
  console.table(errorPatterns);

  console.log("\n=== 5. CROSS-CHAIN MISMATCHES (UNICITY chainId with EVM addresses) ===");
  const crossChainIssues = db.prepare(`
    SELECT id, dealId, chainId, purpose, fromAddr, toAddr, status, 
           recoveryAttempts, recoveryError
    FROM queue_items
    WHERE chainId = 'UNICITY'
      AND (toAddr LIKE '0x%' OR fromAddr LIKE '0x%')
    ORDER BY createdAt DESC
  `).all();
  console.table(crossChainIssues);
  console.log(`Total cross-chain mismatch items: ${crossChainIssues.length}`);

  console.log("\n=== 6. RECENT EVENTS (Last 100, filtered for errors/UTXO) ===");
  const recentEvents = db.prepare(`
    SELECT dealId, datetime(t/1000, 'unixepoch') as timestamp, 
           SUBSTR(msg, 1, 150) as message
    FROM events
    WHERE msg LIKE '%error%' OR msg LIKE '%fail%' OR msg LIKE '%UTXO%' 
       OR msg LIKE '%retry%'
    ORDER BY t DESC
    LIMIT 100
  `).all();
  console.table(recentEvents);

  console.log("\n=== 7. ALL EVENTS FROM LAST 30 MINUTES ===");
  const now = Date.now();
  const thirtyMinAgo = now - (30 * 60 * 1000);
  const recentAllEvents = db.prepare(`
    SELECT dealId, datetime(t/1000, 'unixepoch') as timestamp,
           SUBSTR(msg, 1, 150) as message
    FROM events
    WHERE t >= ?
    ORDER BY t DESC
  `).all(thirtyMinAgo);
  console.table(recentAllEvents);
  console.log(`Total events in last 30 minutes: ${recentAllEvents.length}`);

  console.log("\n=== 8. DEALS IN SWAP STAGE ===");
  const swapDeals = db.prepare(`
    SELECT id, stage, aliceChain, bobChain, 
           datetime(createdAt/1000, 'unixepoch') as created,
           datetime(updatedAt/1000, 'unixepoch') as updated
    FROM deals
    WHERE stage = 'SWAP'
    ORDER BY updatedAt DESC
  `).all();
  console.table(swapDeals);
  console.log(`Total SWAP stage deals: ${swapDeals.length}`);

  console.log("\n=== 9. ALL PENDING ITEMS BY PURPOSE AND CHAIN ===");
  const pendingByPurpose = db.prepare(`
    SELECT purpose, chainId, COUNT(*) as count,
           SUM(recoveryAttempts) as total_recovery_attempts
    FROM queue_items
    WHERE status = 'PENDING'
    GROUP BY purpose, chainId
    ORDER BY count DESC
  `).all();
  console.table(pendingByPurpose);

  console.log("\n=== 10. HIGH RECOVERY ATTEMPT ITEMS (Likely stuck in loops) ===");
  const highRecovery = db.prepare(`
    SELECT id, dealId, chainId, purpose, 
           recoveryAttempts, 
           datetime(lastRecoveryAt/1000, 'unixepoch') as last_recovery,
           SUBSTR(recoveryError, 1, 100) as error
    FROM queue_items
    WHERE recoveryAttempts > 5
    ORDER BY recoveryAttempts DESC
  `).all();
  console.table(highRecovery);
  console.log(`Items with >5 recovery attempts: ${highRecovery.length}`);

  console.log("\n=== 11. QUEUE ITEMS WITH RECENT UPDATES (Last 30 min) ===");
  const recentQueue = db.prepare(`
    SELECT id, dealId, chainId, purpose, status,
           datetime(CAST(REPLACE(lastSubmitAt, 'Z', '') AS INTEGER), 'unixepoch') as last_submit,
           recoveryAttempts
    FROM queue_items
    WHERE lastSubmitAt IS NOT NULL
      AND datetime(REPLACE(lastSubmitAt, 'Z', '')) >= datetime('now', '-30 minutes')
    ORDER BY lastSubmitAt DESC
    LIMIT 50
  `).all();
  console.table(recentQueue);

  console.log("\n=== 12. STUCK PENDING ITEMS (Old and not making progress) ===");
  const stuckItems = db.prepare(`
    SELECT id, dealId, chainId, purpose,
           datetime(REPLACE(createdAt, 'Z', '')) as created,
           recoveryAttempts,
           SUBSTR(recoveryError, 1, 100) as error
    FROM queue_items
    WHERE status = 'PENDING'
      AND datetime(REPLACE(createdAt, 'Z', '')) < datetime('now', '-1 hour')
    ORDER BY createdAt ASC
  `).all();
  console.table(stuckItems);
  console.log(`Stuck items (>1 hour old): ${stuckItems.length}`);

  db.close();
} catch (error) {
  console.error('Error:', error.message);
  console.error(error.stack);
  process.exit(1);
}
