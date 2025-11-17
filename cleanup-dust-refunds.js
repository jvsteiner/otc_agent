#!/usr/bin/env node
/**
 * Clean up uneconomical dust refund queue items
 * Dust amounts cost more in gas than they're worth to refund
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'packages/backend/data/otc-production.db');

console.log('========================================');
console.log('CLEANUP DUST REFUNDS');
console.log('========================================\n');

const db = new Database(dbPath);

// Dust thresholds per chain (must match Engine.ts thresholds)
const dustThresholds = {
  'ETH': 0.005,       // 0.005 ETH
  'POLYGON': 0.1,     // 0.1 MATIC
  'BSC': 0.005,       // 0.005 BNB
  'BASE': 0.002,      // 0.002 ETH
  'SEPOLIA': 0.01,    // Testnet
};

try {
  // Find all late deposit refunds
  const refunds = db.prepare(`
    SELECT id, dealId, chainId, asset, amount, fromAddr, status
    FROM queue_items
    WHERE purpose = 'BROKER_REFUND'
      AND dealId LIKE '%_late_%'
  `).all();

  console.log(`Found ${refunds.length} late deposit refund items\n`);

  let dustCount = 0;
  const dustItems = [];

  refunds.forEach(refund => {
    const threshold = dustThresholds[refund.chainId];

    if (!threshold) {
      console.log(`  ⚠️  No dust threshold for ${refund.chainId}, skipping`);
      return;
    }

    const amount = parseFloat(refund.amount);

    if (amount < threshold) {
      dustCount++;
      dustItems.push(refund);
      console.log(`  [DUST] ${refund.chainId}: ${amount.toFixed(6)} < ${threshold} (${refund.status}) - ${refund.dealId.substring(0, 40)}...`);
    }
  });

  console.log(`\nFound ${dustCount} dust refunds to delete\n`);

  if (dustCount > 0) {
    console.log('Deleting dust refunds...');

    dustItems.forEach(item => {
      db.prepare('DELETE FROM queue_items WHERE id = ?').run(item.id);
    });

    console.log(`✅ Deleted ${dustCount} dust refund items`);
  } else {
    console.log('✅ No dust refunds to clean up');
  }

  console.log('\n========================================');
  console.log('CLEANUP COMPLETE');
  console.log('========================================\n');

} catch (error) {
  console.error('\n❌ Error during cleanup:', error.message);
  console.error(error.stack);
  process.exit(1);
} finally {
  db.close();
}
