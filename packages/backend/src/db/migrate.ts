/**
 * @fileoverview Database migration runner for SQLite schema management.
 * Applies schema and migration files to initialize and update database structure.
 */

import fs from 'fs';
import path from 'path';
import { DB } from './database';

/**
 * Runs database migrations to initialize or update the database schema.
 * Applies the base schema and any migration files in sequence.
 * @param db - Database connection to apply migrations to
 */
export function runMigrations(db: DB): void {
  console.log('Running database migrations...');
  
  // Read and execute schema - handle both compiled and source paths
  let schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    // Try source path when running with tsx
    schemaPath = path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql');
    if (!fs.existsSync(schemaPath)) {
      // Try relative to current file
      schemaPath = path.join(__dirname, 'schema.sql').replace('/dist/', '/src/');
    }
  }
  
  if (!fs.existsSync(schemaPath)) {
    console.error(`Schema file not found! Tried: ${schemaPath}`);
    throw new Error('Database schema not found');
  }
  
  console.log(`Loading schema from: ${schemaPath}`);
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  
  try {
    db.exec(schema);
    
    // Run additional migrations
    let migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      // Try source path when running with tsx
      migrationsDir = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');
    }
    
    if (fs.existsSync(migrationsDir)) {
      const migrationFiles = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();
      
      for (const file of migrationFiles) {
        const migrationPath = path.join(migrationsDir, file);
        const migration = fs.readFileSync(migrationPath, 'utf-8');
        console.log(`Running migration: ${file}`);
        
        // Special handling for the deal name migration
        if (file === '005_add_deal_name.sql') {
          try {
            // Check if the name column already exists
            const checkColumn = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('deals') WHERE name = 'name'").get() as { count: number };
            
            if (checkColumn.count === 0) {
              console.log('Adding name column to deals...');
              db.exec(migration);
            } else {
              console.log('name column already exists, skipping...');
            }
          } catch (err: any) {
            if (!err.message.includes('duplicate column name')) {
              throw err;
            }
            console.log('name column already exists, continuing...');
          }
        }
        // Special handling for the payouts migration
        else if (file === '002_add_payouts.sql') {
          try {
            // First try to add the payoutId column
            const checkColumn = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('queue_items') WHERE name = 'payoutId'").get() as { count: number };

            if (checkColumn.count === 0) {
              console.log('Adding payoutId column to queue_items...');
              db.exec('ALTER TABLE queue_items ADD COLUMN payoutId TEXT REFERENCES payouts(payoutId)');
            } else {
              console.log('payoutId column already exists, skipping...');
            }

            // Run the rest of the migration (tables and indexes)
            db.exec(migration);
          } catch (err: any) {
            if (!err.message.includes('duplicate column name')) {
              throw err;
            }
            console.log('Migration already applied, continuing...');
          }
        }
        // Special handling for the txid resolution migration
        else if (file === '007_add_txid_resolution.sql') {
          try {
            // Check which columns already exist
            const columns = ['is_synthetic', 'original_txid', 'resolution_status', 'resolution_attempts', 'resolved_at', 'resolution_metadata'];
            const existingColumns = new Set<string>();

            for (const col of columns) {
              const checkColumn = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('escrow_deposits') WHERE name = ?").get(col) as { count: number };
              if (checkColumn.count > 0) {
                existingColumns.add(col);
              }
            }

            // Add only missing columns
            if (existingColumns.size < columns.length) {
              console.log('Adding resolution columns to escrow_deposits...');
              if (!existingColumns.has('is_synthetic')) {
                db.exec('ALTER TABLE escrow_deposits ADD COLUMN is_synthetic INTEGER DEFAULT 0');
              }
              if (!existingColumns.has('original_txid')) {
                db.exec('ALTER TABLE escrow_deposits ADD COLUMN original_txid TEXT');
              }
              if (!existingColumns.has('resolution_status')) {
                db.exec('ALTER TABLE escrow_deposits ADD COLUMN resolution_status TEXT DEFAULT \'none\'');
              }
              if (!existingColumns.has('resolution_attempts')) {
                db.exec('ALTER TABLE escrow_deposits ADD COLUMN resolution_attempts INTEGER DEFAULT 0');
              }
              if (!existingColumns.has('resolved_at')) {
                db.exec('ALTER TABLE escrow_deposits ADD COLUMN resolved_at TEXT');
              }
              if (!existingColumns.has('resolution_metadata')) {
                db.exec('ALTER TABLE escrow_deposits ADD COLUMN resolution_metadata TEXT');
              }
            } else {
              console.log('Resolution columns already exist, skipping column additions...');
            }

            // Create txid_resolutions table (with IF NOT EXISTS)
            db.exec(`
              CREATE TABLE IF NOT EXISTS txid_resolutions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dealId TEXT NOT NULL,
                chainId TEXT NOT NULL,
                address TEXT NOT NULL,
                asset TEXT NOT NULL,
                synthetic_txid TEXT NOT NULL,
                resolved_txid TEXT,
                amount TEXT NOT NULL,
                blockHeight INTEGER,
                search_from_block INTEGER,
                search_to_block INTEGER,
                matched_events_count INTEGER,
                confidence_score REAL,
                status TEXT NOT NULL,
                error_message TEXT,
                attempted_at TEXT NOT NULL,
                resolved_at TEXT,
                metadata_json TEXT,
                FOREIGN KEY (dealId) REFERENCES deals(dealId)
              );
            `);

            // Create indexes
            db.exec('CREATE INDEX IF NOT EXISTS idx_escrow_deposits_synthetic ON escrow_deposits(is_synthetic, resolution_status)');
            db.exec('CREATE INDEX IF NOT EXISTS idx_escrow_deposits_resolution_status ON escrow_deposits(resolution_status)');
            db.exec('CREATE INDEX IF NOT EXISTS idx_txid_resolutions_deal ON txid_resolutions(dealId)');
            db.exec('CREATE INDEX IF NOT EXISTS idx_txid_resolutions_status ON txid_resolutions(status)');
            db.exec('CREATE INDEX IF NOT EXISTS idx_txid_resolutions_synthetic_txid ON txid_resolutions(synthetic_txid)');

            console.log('Txid resolution migration completed successfully');
          } catch (err: any) {
            if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
              throw err;
            }
            console.log('Migration already applied, continuing...');
          }
        }
        // Special handling for the broker fields migration
        else if (file === '008_add_broker_fields.sql') {
          try {
            // Check which columns already exist
            const brokerColumns = ['payback', 'recipient', 'feeRecipient', 'fees'];
            const existingBrokerColumns = new Set<string>();

            for (const col of brokerColumns) {
              const checkColumn = db.prepare(
                "SELECT COUNT(*) as count FROM pragma_table_info('queue_items') WHERE name = ?"
              ).get(col) as { count: number };

              if (checkColumn.count > 0) {
                existingBrokerColumns.add(col);
              }
            }

            // Add only missing columns
            if (!existingBrokerColumns.has('payback')) {
              console.log('  Adding payback column');
              db.exec('ALTER TABLE queue_items ADD COLUMN payback TEXT');
            }
            if (!existingBrokerColumns.has('recipient')) {
              console.log('  Adding recipient column');
              db.exec('ALTER TABLE queue_items ADD COLUMN recipient TEXT');
            }
            if (!existingBrokerColumns.has('feeRecipient')) {
              console.log('  Adding feeRecipient column');
              db.exec('ALTER TABLE queue_items ADD COLUMN feeRecipient TEXT');
            }
            if (!existingBrokerColumns.has('fees')) {
              console.log('  Adding fees column');
              db.exec('ALTER TABLE queue_items ADD COLUMN fees TEXT');
            }

            console.log('Broker fields migration completed successfully');
          } catch (err: any) {
            if (!err.message.includes('duplicate column name')) {
              throw err;
            }
            console.log('Migration already applied, continuing...');
          }
        } else {
          db.exec(migration);
        }
      }
    }

    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Failed to run migrations:', error);
    throw error;
  }
}

// If run directly
if (require.main === module) {
  const db = new DB();
  try {
    runMigrations(db);
  } finally {
    db.close();
  }
}