const Database = require('better-sqlite3');
const db = new Database('/home/vrogojin/otc_agent/packages/backend/data/otc-production.db', { readonly: true });

const now = Date.now();
const thirtyMinAgo = now - (30 * 60 * 1000);

console.log("=== EVENT COUNT IN LAST 30 MINUTES ===");
const eventCount = db.prepare(`
  SELECT COUNT(*) as count FROM events WHERE t >= ?
`).get(thirtyMinAgo);
console.log(`Total events: ${eventCount.count}`);

console.log("\n=== ERROR EVENT COUNT (ALL TIME) ===");
const errorCount = db.prepare(`
  SELECT COUNT(*) as count FROM events 
  WHERE msg LIKE '%No UTXOs available%'
`).get();
console.log(`"No UTXOs available" errors: ${errorCount.count}`);

console.log("\n=== ERROR EVENTS BY DEAL (Top 15) ===");
const errorsByDeal = db.prepare(`
  SELECT dealId, COUNT(*) as count 
  FROM events 
  WHERE msg LIKE '%No UTXOs available%'
  GROUP BY dealId
  ORDER BY count DESC
  LIMIT 15
`).all();
console.table(errorsByDeal);

console.log("\n=== SAMPLE OF RECENT TIMESTAMPS ===");
const timestamps = db.prepare(`
  SELECT datetime(t/1000, 'unixepoch') as ts, COUNT(*) as count
  FROM events
  WHERE t >= ?
  GROUP BY datetime(t/1000, 'unixepoch')
  ORDER BY t DESC
  LIMIT 20
`).all(thirtyMinAgo);
console.table(timestamps);

db.close();
