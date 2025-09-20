import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export class DB {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const finalPath = dbPath || process.env.DB_PATH || './data/otc.db';
    
    // Ensure directory exists
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    this.db = new Database(finalPath);
    
    // Enable WAL mode and set pragmas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
  }

  getDb(): Database.Database {
    return this.db;
  }

  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  prepare(sql: string): Database.Statement {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }

  // Helper for async transactions
  async runTxAsync<T>(fn: () => Promise<T>): Promise<T> {
    const transaction = this.db.transaction(async () => {
      return await fn();
    });
    return transaction() as T;
  }
}

export const initDatabase = (dbPath?: string): DB => {
  return new DB(dbPath);
};