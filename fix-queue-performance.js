#!/usr/bin/env node
/**
 * Fix Script for Queue Performance Issues
 *
 * This script:
 * 1. Marks stuck cross-chain mismatched items as FAILED
 * 2. Adds missing composite index for query optimization
 * 3. Provides rollback capability (dry-run mode)
 */

const Database = require('better-sqlite3');
const path = require('path');
const readline = require('readline');

const dbPath = path.join(__dirname, 'packages', 'backend', 'data', 'otc-production.db');

// Parse command line args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const autoConfirm = args.includes('--yes') || args.includes('-y');

console.log('\n🔧 QUEUE PERFORMANCE FIX SCRIPT');
console.log('═'.repeat(80));
console.log(`Database: ${dbPath}`);
console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will modify database)'}`);
console.log('═'.repeat(80));

async function confirm(question) {
  if (autoConfirm) {
    console.log(`${question} [auto-confirmed]`);
    return true;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(`${question} (y/n): `, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function main() {
  const db = new Database(dbPath, { readonly: dryRun });

  try {
    // Step 1: Analyze current state
    console.log('\n1️⃣  ANALYZING CURRENT STATE\n');

    const crossChainItems = db.prepare(`
      SELECT id, dealId, chainId, purpose, fromAddr, toAddr, status, createdAt
      FROM queue_items
      WHERE chainId = 'UNICITY'
        AND (toAddr LIKE '0x%' OR fromAddr LIKE '0x%')
        AND status IN ('PENDING', 'SUBMITTED')
    `).all();

    const oldPendingItems = db.prepare(`
      SELECT id, dealId, chainId, purpose, status,
             (julianday('now') - julianday(createdAt)) * 24 as hours_pending
      FROM queue_items
      WHERE status = 'PENDING'
        AND julianday('now') - julianday(createdAt) > 1
    `).all();

    console.log(`Found ${crossChainItems.length} cross-chain mismatched items (UNICITY with EVM addresses)`);
    console.log(`Found ${oldPendingItems.length} items pending for >24 hours`);

    if (crossChainItems.length === 0 && oldPendingItems.length === 0) {
      console.log('\n✅ No stuck items found! Database is healthy.');
    } else {
      console.log('\nDetails of affected items:');
      console.log('─'.repeat(80));

      if (crossChainItems.length > 0) {
        console.log('\n🚨 Cross-chain mismatched items:');
        crossChainItems.forEach(item => {
          console.log(`  ${item.id.substring(0, 30)} | Deal: ${item.dealId.substring(0, 8)} | ${item.purpose} | ${item.status}`);
        });
      }

      if (oldPendingItems.length > 0) {
        console.log('\n⚠️  Items pending for >24 hours:');
        oldPendingItems.slice(0, 5).forEach(item => {
          console.log(`  ${item.id.substring(0, 30)} | Deal: ${item.dealId.substring(0, 8)} | ${item.purpose} | ${item.hours_pending.toFixed(1)} hours`);
        });
        if (oldPendingItems.length > 5) {
          console.log(`  ... and ${oldPendingItems.length - 5} more`);
        }
      }
    }

    // Step 2: Check indexes
    console.log('\n\n2️⃣  CHECKING INDEXES\n');

    const indexes = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type='index' AND tbl_name='queue_items'
    `).all();

    console.log(`Found ${indexes.length} indexes on queue_items table`);

    // Check if we have the optimal lookup index
    const hasLookupIndex = indexes.some(idx =>
      idx.name === 'idx_queue_items_lookup' ||
      (idx.sql && idx.sql.includes('dealId') && idx.sql.includes('fromAddr') && idx.sql.includes('chainId'))
    );

    if (hasLookupIndex) {
      console.log('✅ Composite lookup index exists');
    } else {
      console.log('⚠️  Missing optimal composite index for getNextPending() query');
    }

    // Step 3: Show fix plan
    console.log('\n\n3️⃣  FIX PLAN\n');

    const fixPlan = [];

    if (crossChainItems.length > 0) {
      fixPlan.push({
        name: 'Mark cross-chain mismatched items as FAILED',
        sql: `UPDATE queue_items SET status = 'FAILED' WHERE chainId = 'UNICITY' AND (toAddr LIKE '0x%' OR fromAddr LIKE '0x%') AND status IN ('PENDING', 'SUBMITTED')`,
        affectedRows: crossChainItems.length,
        critical: true
      });
    }

    if (oldPendingItems.length > 0) {
      fixPlan.push({
        name: 'Mark items pending >24h as FAILED',
        sql: `UPDATE queue_items SET status = 'FAILED' WHERE status = 'PENDING' AND julianday('now') - julianday(createdAt) > 1`,
        affectedRows: oldPendingItems.length,
        critical: false
      });
    }

    if (!hasLookupIndex) {
      fixPlan.push({
        name: 'Add composite index for query optimization',
        sql: `CREATE INDEX IF NOT EXISTS idx_queue_items_lookup ON queue_items(dealId, fromAddr, chainId, status, phase, seq)`,
        affectedRows: 0,
        critical: false
      });
    }

    if (fixPlan.length === 0) {
      console.log('✅ No fixes needed! Database is healthy.');
      db.close();
      return;
    }

    console.log('The following operations will be performed:\n');
    fixPlan.forEach((fix, i) => {
      console.log(`${i + 1}. ${fix.critical ? '🚨' : '⚠️'}  ${fix.name}`);
      console.log(`   SQL: ${fix.sql}`);
      if (fix.affectedRows > 0) {
        console.log(`   Affected rows: ${fix.affectedRows}`);
      }
      console.log();
    });

    if (dryRun) {
      console.log('📋 DRY RUN MODE - No changes will be made');
      console.log('Run without --dry-run flag to apply fixes\n');
      db.close();
      return;
    }

    // Step 4: Confirm and execute
    console.log('\n4️⃣  EXECUTING FIXES\n');

    const proceed = await confirm('⚠️  Apply these fixes to the database?');

    if (!proceed) {
      console.log('\n❌ Operation cancelled by user\n');
      db.close();
      return;
    }

    console.log('\n🔧 Applying fixes...\n');

    db.exec('BEGIN TRANSACTION');

    try {
      let totalAffected = 0;

      fixPlan.forEach((fix, i) => {
        console.log(`${i + 1}. ${fix.name}...`);
        const result = db.prepare(fix.sql).run();
        const affected = result.changes || 0;
        totalAffected += affected;
        console.log(`   ✅ Complete (${affected} rows affected)\n`);
      });

      db.exec('COMMIT');

      console.log('═'.repeat(80));
      console.log(`\n✅ SUCCESS! Applied ${fixPlan.length} fixes, affected ${totalAffected} rows\n`);

      // Verify fixes
      console.log('5️⃣  VERIFYING FIXES\n');

      const remainingBadItems = db.prepare(`
        SELECT COUNT(*) as count FROM queue_items
        WHERE chainId = 'UNICITY'
          AND (toAddr LIKE '0x%' OR fromAddr LIKE '0x%')
          AND status IN ('PENDING', 'SUBMITTED')
      `).get();

      const remainingOldPending = db.prepare(`
        SELECT COUNT(*) as count FROM queue_items
        WHERE status = 'PENDING'
          AND julianday('now') - julianday(createdAt) > 1
      `).get();

      console.log(`Cross-chain mismatched items: ${remainingBadItems.count} (was ${crossChainItems.length})`);
      console.log(`Items pending >24h: ${remainingOldPending.count} (was ${oldPendingItems.length})`);

      if (remainingBadItems.count === 0 && remainingOldPending.count === 0) {
        console.log('\n✅ All stuck items have been resolved!\n');
      } else {
        console.log('\n⚠️  Some items remain - may need manual investigation\n');
      }

    } catch (error) {
      db.exec('ROLLBACK');
      console.error('\n❌ Error applying fixes:', error.message);
      console.error('Transaction rolled back - no changes made\n');
      throw error;
    }

  } finally {
    db.close();
  }
}

// Show usage if --help
if (args.includes('--help') || args.includes('-h')) {
  console.log('\nUsage: node fix-queue-performance.js [options]\n');
  console.log('Options:');
  console.log('  --dry-run    Preview changes without modifying database');
  console.log('  --yes, -y    Auto-confirm all prompts');
  console.log('  --help, -h   Show this help message\n');
  console.log('Examples:');
  console.log('  node fix-queue-performance.js --dry-run       # Preview changes');
  console.log('  node fix-queue-performance.js --yes           # Apply fixes without prompts');
  console.log('  node fix-queue-performance.js                 # Apply fixes with confirmation\n');
  process.exit(0);
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
