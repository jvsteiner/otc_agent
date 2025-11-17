#!/usr/bin/env node
/**
 * COMPREHENSIVE CLEANUP SCRIPT
 * Fixes the system freeze issue by cleaning up:
 * 1. Orphaned queue items for non-existent "_late_" deals
 * 2. Excessive events from deal f675c7ef6a32f67f267c7717837956fb (Nov 1-13, 2025)
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'packages/backend/data/otc-production.db');
const dealId = 'f675c7ef6a32f67f267c7717837956fb';

console.log('========================================');
console.log('COMPREHENSIVE CLEANUP');
console.log('========================================\n');

const db = new Database(dbPath);

try {
  // PART 1: Clean orphaned queue items
  console.log('[1/2] Cleaning orphaned queue items...\n');

  // Count orphaned items
  const orphanedCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM queue_items
    WHERE dealId LIKE '%_late_%'
  `).get();

  console.log(`  Found ${orphanedCount.count} orphaned late deposit queue items`);

  // Show sample before deletion
  const sampleOrphaned = db.prepare(`
    SELECT dealId, id, status, purpose
    FROM queue_items
    WHERE dealId LIKE '%_late_%'
    LIMIT 5
  `).all();

  console.log('\n  Sample orphaned items:');
  sampleOrphaned.forEach(item => {
    console.log(`    ${item.dealId.substring(0, 70)} (${item.purpose}, ${item.status})`);
  });

  // Delete orphaned items
  const deleteResult = db.prepare(`
    DELETE FROM queue_items
    WHERE dealId LIKE '%_late_%'
  `).run();

  console.log(`\n  ✓ Deleted ${deleteResult.changes} orphaned queue items\n`);

  // PART 2: Clean excessive events from main deal
  console.log('[2/2] Cleaning excessive events from main deal...\n');

  const dealRow = db.prepare('SELECT dealId, stage, json FROM deals WHERE dealId = ?').get(dealId);

  if (!dealRow) {
    console.log('  ⚠️  Deal not found, skipping event cleanup');
  } else {
    const deal = JSON.parse(dealRow.json);
    const events = deal.events || [];

    console.log(`  Deal: ${dealRow.dealId}`);
    console.log(`  Stage: ${dealRow.stage}`);
    console.log(`  Current event count: ${events.length}`);

    // Filter out events between Nov 1-13, 2025
    const startDate = new Date('2025-11-01T00:00:00Z');
    const endDate = new Date('2025-11-13T23:59:59.999Z');

    const filteredEvents = events.filter(event => {
      if (!event.t) {
        return true; // Keep events without timestamp
      }
      const eventDate = new Date(event.t);
      return eventDate < startDate || eventDate > endDate;
    });

    const removed = events.length - filteredEvents.length;

    console.log(`  Events to remove: ${removed} (from Nov 1-13, 2025)`);
    console.log(`  Events to keep: ${filteredEvents.length}`);

    // Update the deal
    deal.events = filteredEvents;
    const updatedJson = JSON.stringify(deal);

    db.prepare('UPDATE deals SET json = ? WHERE dealId = ?').run(updatedJson, dealId);

    console.log(`\n  ✓ Removed ${removed} events from deal ${dealId}\n`);
  }

  console.log('========================================');
  console.log('✅ CLEANUP COMPLETE');
  console.log('========================================\n');

  console.log('Summary:');
  console.log(`  - Deleted ${deleteResult.changes} orphaned queue items`);
  if (dealRow) {
    const events = JSON.parse(dealRow.json).events || [];
    const removed = events.length - JSON.parse(db.prepare('SELECT json FROM deals WHERE dealId = ?').get(dealId).json).events.length;
    console.log(`  - Removed ${removed} events from deal ${dealId}`);
  }
  console.log('\nThe backend should now run smoothly!');
  console.log('Restart with: sudo ./run-prod.sh\n');

} catch (error) {
  console.error('\n❌ Error during cleanup:', error.message);
  console.error(error.stack);
  process.exit(1);
} finally {
  db.close();
}
