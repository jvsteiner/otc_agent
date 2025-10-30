const Database = require('better-sqlite3');
const db = new Database('/home/vrogojin/otc_agent/packages/backend/data/otc-production.db', { readonly: true });

console.log("=== QUEUE_ITEMS TABLE SCHEMA ===");
const schema = db.prepare("PRAGMA table_info(queue_items)").all();
console.table(schema);

console.log("\n=== SAMPLE QUEUE ITEM ===");
const sample = db.prepare("SELECT * FROM queue_items LIMIT 1").get();
console.log(JSON.stringify(sample, null, 2));

db.close();
