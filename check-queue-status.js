#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'packages/backend/data/otc-production.db');
const db = new Database(dbPath, { readonly: true });

try {
  const summary = db.prepare(`
    SELECT purpose, status, COUNT(*) as count
    FROM queue_items
    GROUP BY purpose, status
    ORDER BY purpose, status
  `).all();

  console.log('\n=== Queue Items Summary ===');
  summary.forEach(row => {
    console.log(`${row.purpose.padEnd(25)} ${row.status.padEnd(12)} ${row.count}`);
  });

  const pending = db.prepare(`SELECT COUNT(*) as count FROM queue_items WHERE status = 'PENDING'`).get();
  const failed = db.prepare(`SELECT COUNT(*) as count FROM queue_items WHERE status = 'FAILED'`).get();

  console.log(`\n=== Summary ===`);
  console.log(`Pending items: ${pending.count}`);
  console.log(`Failed items: ${failed.count}`);

  // Check for orphaned late deposit refunds
  const orphaned = db.prepare(`
    SELECT COUNT(*) as count
    FROM queue_items
    WHERE purpose = 'BROKER_REFUND'
      AND dealId LIKE '%_late_%'
  `).get();

  console.log(`Orphaned late deposits: ${orphaned.count}`);

} finally {
  db.close();
}
