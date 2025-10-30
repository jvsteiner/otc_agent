#!/usr/bin/env node
/**
 * INCIDENT FIX SCRIPT
 *
 * CRITICAL: This script fixes the infinite error loop caused by cross-chain address mismatches
 * in GAS_REFUND_TO_TANK queue items where UNICITY chainId has EVM addresses (0x...).
 *
 * Impact: 2.6M+ errors, 596MB database, ~76 days of accumulated errors
 * Root Cause: UTXO chain (UNICITY) attempting to send to EVM addresses
 */

const Database = require('better-sqlite3');
const path = require('path');
const readline = require('readline');

const dbPath = path.join(__dirname, 'packages/backend/data/otc-production.db');

console.log("=== INCIDENT FIX: Cross-Chain Address Mismatch ===\n");
console.log(`Database: ${dbPath}\n`);

const db = new Database(dbPath);

// Step 1: Show current status
console.log("Step 1: CURRENT STATUS");
console.log("-".repeat(80));

const stuckItems = db.prepare(`
  SELECT id, dealId, chainId, purpose, fromAddr, toAddr, status
  FROM queue_items
  WHERE chainId = 'UNICITY' AND toAddr LIKE '0x%' AND status = 'PENDING'
`).all();

console.log(`Found ${stuckItems.length} stuck PENDING items with cross-chain mismatch:\n`);
stuckItems.forEach((item, i) => {
  console.log(`${i + 1}. ${item.id}`);
  console.log(`   Deal: ${item.dealId}`);
  console.log(`   Purpose: ${item.purpose}`);
  console.log(`   From (UNICITY): ${item.fromAddr}`);
  console.log(`   To (EVM addr): ${item.toAddr}`);
  console.log();
});

const totalErrors = db.prepare(`
  SELECT COUNT(*) as count FROM events WHERE msg LIKE '%No UTXOs available%'
`).get();
console.log(`Total accumulated errors: ${totalErrors.count.toLocaleString()}\n`);

// Step 2: Confirm
console.log("\nStep 2: CONFIRMATION");
console.log("-".repeat(80));

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('This will mark all stuck items as FAILED. Continue? (yes/no): ', (answer) => {
  if (answer.toLowerCase() !== 'yes') {
    console.log("Aborted.");
    rl.close();
    db.close();
    process.exit(0);
  }

  // Step 3: Apply fix
  console.log("\nStep 3: APPLYING FIX");
  console.log("-".repeat(80));

  try {
    db.exec('BEGIN TRANSACTION');

    // Mark items as FAILED
    const updateResult = db.prepare(`
      UPDATE queue_items
      SET status = 'FAILED',
          recoveryError = 'INCIDENT_FIX: Cross-chain address mismatch - UNICITY chain cannot send to EVM address'
      WHERE chainId = 'UNICITY'
        AND toAddr LIKE '0x%'
        AND status = 'PENDING'
        AND purpose = 'GAS_REFUND_TO_TANK'
    `).run();

    console.log(`Updated ${updateResult.changes} queue items to FAILED status`);

    // Log the fix in events
    const now = Date.now();
    const dealIds = [...new Set(stuckItems.map(i => i.dealId))];
    const insertEvent = db.prepare(`
      INSERT INTO events (dealId, t, msg) VALUES (?, ?, ?)
    `);

    dealIds.forEach(dealId => {
      insertEvent.run(
        dealId,
        now,
        'INCIDENT_FIX: Marked stuck GAS_REFUND_TO_TANK as FAILED due to cross-chain address mismatch'
      );
    });

    console.log(`Logged fix event for ${dealIds.length} deals`);

    db.exec('COMMIT');
    console.log("\nFix applied successfully!\n");

    // Step 4: Verification
    console.log("Step 4: VERIFICATION");
    console.log("-".repeat(80));

    const remaining = db.prepare(`
      SELECT COUNT(*) as count FROM queue_items
      WHERE chainId = 'UNICITY' AND toAddr LIKE '0x%' AND status = 'PENDING'
    `).get();
    console.log(`Remaining stuck PENDING items: ${remaining.count}`);

    const failed = db.prepare(`
      SELECT COUNT(*) as count FROM queue_items
      WHERE status = 'FAILED' AND recoveryError LIKE 'INCIDENT_FIX%'
    `).get();
    console.log(`Items marked as FAILED by this fix: ${failed.count}`);

    const pendingByPurpose = db.prepare(`
      SELECT purpose, chainId, COUNT(*) as count
      FROM queue_items
      WHERE status = 'PENDING'
      GROUP BY purpose, chainId
    `).all();

    console.log("\nRemaining PENDING items by purpose:");
    console.table(pendingByPurpose);

    console.log("\n=== FIX COMPLETE ===");
    console.log("The infinite error loop has been broken.");
    console.log("Monitor the system to ensure:");
    console.log("1. No new 'No UTXOs available' errors for these deals");
    console.log("2. System performance returns to normal");
    console.log("3. Recent code fix prevents new items from being created");
    console.log("\nRecommendation: Restart backend to clear any in-memory state.");

  } catch (error) {
    db.exec('ROLLBACK');
    console.error("\nERROR during fix:", error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    rl.close();
    db.close();
  }
});
