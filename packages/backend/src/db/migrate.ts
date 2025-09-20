import fs from 'fs';
import path from 'path';
import { DB } from './database';

export function runMigrations(db: DB): void {
  console.log('Running database migrations...');
  
  // Read and execute schema
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  
  try {
    db.exec(schema);
    
    // Run additional migrations
    const migrationsDir = path.join(__dirname, 'migrations');
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