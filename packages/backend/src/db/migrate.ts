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