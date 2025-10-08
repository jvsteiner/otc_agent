/**
 * @fileoverview Database wrapper for SQLite with WAL mode and transaction support.
 * Provides core database operations, transaction management, and wallet index persistence.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

/**
 * Database wrapper class that manages SQLite connection and provides
 * transaction support, prepared statements, and specialized methods
 * for wallet index management.
 */
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

  /**
   * Executes a function within a database transaction.
   * Automatically rolls back on error.
   * @param fn - Function to execute within transaction
   * @returns Result of the function
   */
  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Prepares a SQL statement for repeated execution.
   * @param sql - SQL statement to prepare
   * @returns Prepared statement
   */
  prepare(sql: string): Database.Statement {
    return this.db.prepare(sql);
  }

  /**
   * Executes a SQL string directly (for DDL operations).
   * @param sql - SQL to execute
   */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * Closes the database connection.
   */
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

  // Wallet index management
  getNextWalletIndex(chainId: string): number {
    return this.runInTransaction(() => {
      // First ensure the table exists
      this.exec(`CREATE TABLE IF NOT EXISTS wallet_indices (
        chainId TEXT PRIMARY KEY,
        lastIndex INTEGER NOT NULL DEFAULT 0
      )`);
      
      // Get current index
      const row = this.prepare('SELECT lastIndex FROM wallet_indices WHERE chainId = ?').get(chainId) as { lastIndex: number } | undefined;
      const currentIndex = row ? row.lastIndex : 0;
      const nextIndex = currentIndex + 1;
      
      // Update or insert the new index
      this.prepare(`
        INSERT INTO wallet_indices (chainId, lastIndex) VALUES (?, ?)
        ON CONFLICT(chainId) DO UPDATE SET lastIndex = excluded.lastIndex
      `).run(chainId, nextIndex);
      
      return nextIndex;
    });
  }

  getCurrentWalletIndex(chainId: string): number {
    // Ensure the table exists
    this.exec(`CREATE TABLE IF NOT EXISTS wallet_indices (
      chainId TEXT PRIMARY KEY,
      lastIndex INTEGER NOT NULL DEFAULT 0
    )`);
    
    const row = this.prepare('SELECT lastIndex FROM wallet_indices WHERE chainId = ?').get(chainId) as { lastIndex: number } | undefined;
    return row ? row.lastIndex : 0;
  }

  // Check if an escrow address is already in use
  isEscrowAddressInUse(address: string): boolean {
    const result = this.prepare(`
      SELECT COUNT(*) as count FROM party_details 
      WHERE escrowAddress = ?
    `).get(address) as { count: number };
    
    return result.count > 0;
  }
}

export const initDatabase = (dbPath?: string): DB => {
  return new DB(dbPath);
};