const Database = require('better-sqlite3');
const db = new Database('/home/vrogojin/otc_agent/packages/backend/data/otc-production.db', { readonly: true });

// Get database size
const fs = require('fs');
const stats = fs.statSync('/home/vrogojin/otc_agent/packages/backend/data/otc-production.db');
console.log(`Database size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

// Total errors
const totalErrors = db.prepare(`
  SELECT COUNT(*) as count FROM events
  WHERE msg LIKE '%No UTXOs available%'
`).get();

console.log(`\nTotal "No UTXOs available" errors: ${totalErrors.count.toLocaleString()}`);

// If 30s engine loop and 12 stuck items...
console.log("\n=== ERROR LOOP ANALYSIS ===");
console.log("Assuming 30-second engine loop with 12 stuck GAS_REFUND_TO_TANK items:");
console.log(`- Errors per item: ${Math.floor(totalErrors.count / 12).toLocaleString()}`);
console.log(`- Estimated iterations: ${Math.floor(totalErrors.count / 12).toLocaleString()}`);
console.log(`- Estimated time: ${Math.floor((totalErrors.count / 12 * 30) / 3600).toLocaleString()} hours`);
console.log(`- Days of errors: ${Math.floor((totalErrors.count / 12 * 30) / 86400).toLocaleString()} days`);

// Check oldest error
const oldestError = db.prepare(`
  SELECT datetime(t/1000, 'unixepoch') as ts
  FROM events
  WHERE msg LIKE '%No UTXOs available%'
  ORDER BY t ASC
  LIMIT 1
`).get();
console.log(`\nOldest error: ${oldestError?.ts || 'unknown'}`);

// Check newest error
const newestError = db.prepare(`
  SELECT datetime(t/1000, 'unixepoch') as ts
  FROM events
  WHERE msg LIKE '%No UTXOs available%'
  ORDER BY t DESC
  LIMIT 1
`).get();
console.log(`Newest error: ${newestError?.ts || 'unknown'}`);

db.close();
