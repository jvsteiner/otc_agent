#!/usr/bin/env node
/**
 * Database Performance Analysis Script for queue_items table
 * Investigates performance issues causing backend degradation
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'packages', 'backend', 'data', 'otc-production.db');
console.log(`\n📊 DATABASE PERFORMANCE ANALYSIS`);
console.log(`Database: ${dbPath}\n`);
console.log('═'.repeat(80));

try {
  const db = new Database(dbPath, { readonly: true });

  // Enable optimizations for read queries
  db.pragma('cache_size = 10000');
  db.pragma('temp_store = memory');

  console.log('\n1️⃣  TABLE SCHEMA AND INDEXES');
  console.log('─'.repeat(80));

  // Get table schema
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='queue_items'").get();
  console.log('\nTable Schema:');
  console.log(schema?.sql || 'Table not found!');

  // Get all indexes on queue_items
  const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='queue_items'").all();
  console.log('\nExisting Indexes:');
  if (indexes.length === 0) {
    console.log('⚠️  NO INDEXES FOUND - This is a major performance issue!');
  } else {
    indexes.forEach(idx => {
      console.log(`  - ${idx.name}`);
      console.log(`    ${idx.sql || '(auto-generated)'}`);
    });
  }

  console.log('\n\n2️⃣  DATA DISTRIBUTION BY STATUS');
  console.log('─'.repeat(80));

  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM queue_items
    GROUP BY status
    ORDER BY count DESC
  `).all();

  console.log('\nQueue Items by Status:');
  statusCounts.forEach(row => {
    console.log(`  ${row.status.padEnd(15)} : ${row.count}`);
  });

  const totalItems = statusCounts.reduce((sum, row) => sum + row.count, 0);
  console.log(`  ${'TOTAL'.padEnd(15)} : ${totalItems}`);

  console.log('\n\n3️⃣  STUCK PENDING ITEMS');
  console.log('─'.repeat(80));

  const pendingItems = db.prepare(`
    SELECT id, dealId, chainId, purpose, phase, fromAddr, toAddr, asset, amount, createdAt
    FROM queue_items
    WHERE status = 'PENDING'
    ORDER BY createdAt
  `).all();

  console.log(`\nFound ${pendingItems.length} PENDING items:`);
  if (pendingItems.length > 0) {
    console.log('\n  ID                              | Deal       | Chain    | Purpose         | Phase  | Created');
    console.log('  ' + '─'.repeat(110));
    pendingItems.slice(0, 20).forEach(item => {
      console.log(`  ${item.id.substring(0, 30)} | ${item.dealId.substring(0, 8)} | ${item.chainId.padEnd(8)} | ${item.purpose.padEnd(15)} | ${(item.phase || 'NULL').padEnd(6)} | ${item.createdAt}`);
    });

    if (pendingItems.length > 20) {
      console.log(`  ... and ${pendingItems.length - 20} more`);
    }
  }

  console.log('\n\n4️⃣  CROSS-CHAIN ADDRESS MISMATCHES');
  console.log('─'.repeat(80));

  // Find UNICITY items with EVM addresses
  const unicityWithEvm = db.prepare(`
    SELECT id, dealId, chainId, purpose, fromAddr, toAddr, status
    FROM queue_items
    WHERE chainId = 'UNICITY'
      AND (toAddr LIKE '0x%' OR fromAddr LIKE '0x%')
      AND status IN ('PENDING', 'SUBMITTED')
  `).all();

  console.log(`\n🚨 CRITICAL: Found ${unicityWithEvm.length} UNICITY items with EVM addresses:`);
  if (unicityWithEvm.length > 0) {
    console.log('\n  ID                              | Deal       | Purpose         | From                | To                  | Status');
    console.log('  ' + '─'.repeat(130));
    unicityWithEvm.forEach(item => {
      console.log(`  ${item.id.substring(0, 30)} | ${item.dealId.substring(0, 8)} | ${item.purpose.padEnd(15)} | ${item.fromAddr.substring(0, 18)} | ${item.toAddr.substring(0, 18)} | ${item.status}`);
    });
  }

  // Find EVM items with UNICITY addresses
  const evmWithUnicity = db.prepare(`
    SELECT id, dealId, chainId, purpose, fromAddr, toAddr, status
    FROM queue_items
    WHERE chainId != 'UNICITY'
      AND (toAddr LIKE 'alpha1%' OR fromAddr LIKE 'alpha1%')
      AND status IN ('PENDING', 'SUBMITTED')
  `).all();

  console.log(`\n🚨 CRITICAL: Found ${evmWithUnicity.length} EVM items with UNICITY addresses:`);
  if (evmWithUnicity.length > 0) {
    console.log('\n  ID                              | Deal       | Chain    | Purpose         | From                | To                  | Status');
    console.log('  ' + '─'.repeat(140));
    evmWithUnicity.forEach(item => {
      console.log(`  ${item.id.substring(0, 30)} | ${item.dealId.substring(0, 8)} | ${item.chainId.padEnd(8)} | ${item.purpose.padEnd(15)} | ${item.fromAddr.substring(0, 18)} | ${item.toAddr.substring(0, 18)} | ${item.status}`);
    });
  }

  console.log('\n\n5️⃣  DEALS WITH EXCESSIVE QUEUE ITEMS');
  console.log('─'.repeat(80));

  const dealCounts = db.prepare(`
    SELECT dealId, purpose, COUNT(*) as count
    FROM queue_items
    WHERE status IN ('PENDING', 'SUBMITTED')
    GROUP BY dealId, purpose
    HAVING count > 5
    ORDER BY count DESC
  `).all();

  console.log(`\nDeals with >5 items of same purpose (possible retry loops):`);
  if (dealCounts.length > 0) {
    console.log('\n  Deal       | Purpose                  | Count');
    console.log('  ' + '─'.repeat(55));
    dealCounts.forEach(row => {
      console.log(`  ${row.dealId.substring(0, 8)} | ${row.purpose.padEnd(24)} | ${row.count}`);
    });
  } else {
    console.log('  ✅ No deals with excessive retries');
  }

  console.log('\n\n6️⃣  ITEMS BY DEAL AND PURPOSE');
  console.log('─'.repeat(80));

  const dealPurpose = db.prepare(`
    SELECT dealId, purpose, status, COUNT(*) as count
    FROM queue_items
    GROUP BY dealId, purpose, status
    ORDER BY dealId, purpose, status
  `).all();

  console.log(`\nBreakdown by Deal, Purpose, and Status:`);
  console.log('\n  Deal       | Purpose                  | Status     | Count');
  console.log('  ' + '─'.repeat(75));
  dealPurpose.forEach(row => {
    console.log(`  ${row.dealId.substring(0, 8)} | ${row.purpose.padEnd(24)} | ${row.status.padEnd(10)} | ${row.count}`);
  });

  console.log('\n\n7️⃣  QUERY PERFORMANCE ANALYSIS');
  console.log('─'.repeat(80));

  // Test getNextPending query performance
  console.log('\nAnalyzing getNextPending() query pattern...');

  // Example query used by QueueProcessor
  const explainQuery = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM queue_items
    WHERE dealId = ? AND fromAddr = ? AND chainId = ? AND status = 'PENDING' AND phase = ?
    ORDER BY seq
    LIMIT 1
  `);

  const queryPlan = explainQuery.all('test-deal', 'test-addr', 'UNICITY', 'PHASE_1_SWAP');
  console.log('\nQuery Plan for getNextPending():');
  queryPlan.forEach(row => {
    console.log(`  ${row.detail}`);
  });

  // Check if it's doing table scans
  const isTableScan = queryPlan.some(row => row.detail.includes('SCAN'));
  if (isTableScan) {
    console.log('\n⚠️  WARNING: Query is performing table scans! Missing index on (dealId, fromAddr, chainId, status, phase)');
  } else {
    console.log('\n✅ Query is using indexes efficiently');
  }

  console.log('\n\n8️⃣  ITEMS WITH CROSS-CHAIN MISMATCHES (DETAILED)');
  console.log('─'.repeat(80));

  // Get all PENDING/SUBMITTED items and check for mismatches
  const allActiveItems = db.prepare(`
    SELECT id, dealId, chainId, purpose, phase, fromAddr, toAddr, asset, amount, status, createdAt
    FROM queue_items
    WHERE status IN ('PENDING', 'SUBMITTED')
    ORDER BY createdAt
  `).all();

  const mismatches = allActiveItems.filter(item => {
    const isUnicityChain = item.chainId === 'UNICITY';
    const hasEvmFrom = item.fromAddr.startsWith('0x');
    const hasEvmTo = item.toAddr.startsWith('0x');
    const hasUnicityFrom = item.fromAddr.startsWith('alpha1');
    const hasUnicityTo = item.toAddr.startsWith('alpha1');

    // UNICITY chain should only have UNICITY addresses
    if (isUnicityChain && (hasEvmFrom || hasEvmTo)) {
      return true;
    }

    // EVM chains should only have EVM addresses
    if (!isUnicityChain && (hasUnicityFrom || hasUnicityTo)) {
      return true;
    }

    return false;
  });

  console.log(`\n🚨 Found ${mismatches.length} items with address/chain mismatches:`);
  if (mismatches.length > 0) {
    console.log('\n  ID                              | Deal       | Chain    | Purpose         | From              | To                | Status');
    console.log('  ' + '─'.repeat(140));
    mismatches.forEach(item => {
      const fromPrefix = item.fromAddr.substring(0, 15);
      const toPrefix = item.toAddr.substring(0, 15);
      console.log(`  ${item.id.substring(0, 30)} | ${item.dealId.substring(0, 8)} | ${item.chainId.padEnd(8)} | ${item.purpose.padEnd(15)} | ${fromPrefix.padEnd(17)} | ${toPrefix.padEnd(17)} | ${item.status}`);
    });
  }

  console.log('\n\n9️⃣  OLDEST PENDING ITEMS');
  console.log('─'.repeat(80));

  const oldestPending = db.prepare(`
    SELECT id, dealId, chainId, purpose, phase, fromAddr, toAddr, createdAt,
           (julianday('now') - julianday(createdAt)) * 24 as hours_pending
    FROM queue_items
    WHERE status = 'PENDING'
    ORDER BY createdAt
    LIMIT 10
  `).all();

  console.log(`\nOldest PENDING items (may be stuck):`);
  if (oldestPending.length > 0) {
    console.log('\n  ID                              | Deal       | Purpose         | Hours Pending | Created');
    console.log('  ' + '─'.repeat(105));
    oldestPending.forEach(item => {
      console.log(`  ${item.id.substring(0, 30)} | ${item.dealId.substring(0, 8)} | ${item.purpose.padEnd(15)} | ${item.hours_pending.toFixed(1).padStart(13)} | ${item.createdAt}`);
    });
  }

  console.log('\n\n🔟  PERFORMANCE RECOMMENDATIONS');
  console.log('═'.repeat(80));

  console.log('\n📋 Index Recommendations:');

  if (indexes.length === 0) {
    console.log('\n  🚨 CRITICAL: No indexes found! Add these indexes immediately:');
    console.log('\n  CREATE INDEX IF NOT EXISTS idx_queue_items_lookup');
    console.log('    ON queue_items(dealId, fromAddr, chainId, status, phase, seq);');
    console.log('\n  CREATE INDEX IF NOT EXISTS idx_queue_items_status');
    console.log('    ON queue_items(status, createdAt);');
    console.log('\n  CREATE INDEX IF NOT EXISTS idx_queue_items_deal_status');
    console.log('    ON queue_items(dealId, status);');
  } else {
    // Check if we have the right indexes
    const hasLookupIndex = indexes.some(idx =>
      idx.sql && (idx.sql.includes('dealId') && idx.sql.includes('fromAddr') && idx.sql.includes('status'))
    );

    if (!hasLookupIndex) {
      console.log('\n  ⚠️  Missing composite index for getNextPending() query:');
      console.log('\n  CREATE INDEX IF NOT EXISTS idx_queue_items_lookup');
      console.log('    ON queue_items(dealId, fromAddr, chainId, status, phase, seq);');
    } else {
      console.log('\n  ✅ Composite indexes exist for queue lookups');
    }
  }

  console.log('\n\n📋 SQL Commands to Fix Stuck Items:');

  if (mismatches.length > 0) {
    console.log('\n  🚨 CRITICAL: Mark cross-chain mismatched items as FAILED:');
    console.log('\n  -- Mark all UNICITY items with EVM addresses as FAILED');
    console.log(`  UPDATE queue_items`);
    console.log(`  SET status = 'FAILED'`);
    console.log(`  WHERE chainId = 'UNICITY'`);
    console.log(`    AND (toAddr LIKE '0x%' OR fromAddr LIKE '0x%')`);
    console.log(`    AND status IN ('PENDING', 'SUBMITTED');`);
    console.log(`  -- This will affect ${unicityWithEvm.length} items\n`);

    if (evmWithUnicity.length > 0) {
      console.log(`  -- Mark all EVM items with UNICITY addresses as FAILED`);
      console.log(`  UPDATE queue_items`);
      console.log(`  SET status = 'FAILED'`);
      console.log(`  WHERE chainId != 'UNICITY'`);
      console.log(`    AND (toAddr LIKE 'alpha1%' OR fromAddr LIKE 'alpha1%')`);
      console.log(`    AND status IN ('PENDING', 'SUBMITTED');`);
      console.log(`  -- This will affect ${evmWithUnicity.length} items\n`);
    }
  }

  if (oldestPending.length > 0) {
    const veryOldItems = oldestPending.filter(item => item.hours_pending > 24);
    if (veryOldItems.length > 0) {
      console.log('\n  ⚠️  Mark items pending for >24 hours as FAILED:');
      console.log('\n  UPDATE queue_items');
      console.log(`  SET status = 'FAILED'`);
      console.log(`  WHERE status = 'PENDING'`);
      console.log(`    AND julianday('now') - julianday(createdAt) > 1;`);
      console.log(`  -- This will affect items older than 24 hours\n`);
    }
  }

  console.log('\n\n📊 SUMMARY');
  console.log('═'.repeat(80));
  console.log(`\n  Total queue items: ${totalItems}`);
  console.log(`  PENDING items: ${pendingItems.length}`);
  console.log(`  Cross-chain mismatches: ${mismatches.length}`);
  console.log(`  Indexes found: ${indexes.length}`);
  console.log(`  Table scans detected: ${isTableScan ? 'YES ⚠️' : 'NO ✅'}`);

  if (mismatches.length > 0 || isTableScan || indexes.length === 0) {
    console.log(`\n  ⚠️  ACTION REQUIRED: Database has performance issues!`);
    console.log(`      - ${mismatches.length > 0 ? `${mismatches.length} stuck items need to be marked as FAILED` : ''}`);
    console.log(`      - ${isTableScan ? 'Table scans occurring due to missing indexes' : ''}`);
    console.log(`      - ${indexes.length === 0 ? 'No indexes found - add indexes immediately!' : ''}`);
  } else {
    console.log(`\n  ✅ Database appears healthy`);
  }

  console.log('\n' + '═'.repeat(80) + '\n');

  db.close();

} catch (error) {
  console.error('\n❌ Error analyzing database:', error.message);
  console.error(error.stack);
  process.exit(1);
}
