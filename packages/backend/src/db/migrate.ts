import fs from 'fs';
import path from 'path';
import { DB } from './database';

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
        db.exec(migration);
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