/**
 * @fileoverview Repository for managing account state including nonces for EVM chains.
 * Tracks nonce state per address to prevent nonce collisions during concurrent transactions.
 */

import { ChainId } from '@otc-broker/core';
import { Database } from 'better-sqlite3';

export interface AccountState {
  chainId: ChainId;
  address: string;
  lastUsedNonce: number | null;
  lastConfirmedNonce: number | null;
  updatedAt: string;
}

/**
 * Repository for account state management.
 * Handles nonce tracking for EVM chains to ensure serial transaction submission.
 */
export class AccountRepository {
  constructor(private db: Database) {}

  /**
   * Get account state or create if not exists
   */
  getOrCreate(chainId: ChainId, address: string): AccountState {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO accounts (chainId, address, lastUsedNonce, lastConfirmedNonce, updatedAt)
      VALUES (?, ?, NULL, NULL, datetime('now'))
    `);
    stmt.run(chainId, address.toLowerCase());

    const selectStmt = this.db.prepare(`
      SELECT * FROM accounts WHERE chainId = ? AND LOWER(address) = LOWER(?)
    `);
    const row = selectStmt.get(chainId, address) as any;

    if (!row) {
      throw new Error(`Failed to get/create account state for ${chainId}:${address}`);
    }

    return {
      chainId: row.chainId,
      address: row.address,
      lastUsedNonce: row.lastUsedNonce,
      lastConfirmedNonce: row.lastConfirmedNonce,
      updatedAt: row.updatedAt
    };
  }

  /**
   * Get the next nonce to use for a transaction.
   * If we have a lastUsedNonce, return lastUsedNonce + 1.
   * Otherwise, the caller should fetch from network.
   */
  getNextNonce(chainId: ChainId, address: string): number | null {
    const account = this.getOrCreate(chainId, address);

    if (account.lastUsedNonce !== null) {
      return account.lastUsedNonce + 1;
    }

    // No nonce tracked yet - caller should fetch from network
    return null;
  }

  /**
   * Update the last used nonce after submitting a transaction
   * This should be called atomically with transaction submission
   */
  updateLastUsedNonce(chainId: ChainId, address: string, nonce: number): void {
    const stmt = this.db.prepare(`
      UPDATE accounts
      SET lastUsedNonce = ?, updatedAt = datetime('now')
      WHERE chainId = ? AND LOWER(address) = LOWER(?)
    `);

    const result = stmt.run(nonce, chainId, address);

    if (result.changes === 0) {
      // Account doesn't exist, create it
      this.getOrCreate(chainId, address);
      stmt.run(nonce, chainId, address);
    }
  }

  /**
   * Update the last confirmed nonce when a transaction is confirmed
   * This helps with recovery after crashes
   */
  updateLastConfirmedNonce(chainId: ChainId, address: string, nonce: number): void {
    const stmt = this.db.prepare(`
      UPDATE accounts
      SET lastConfirmedNonce = ?, updatedAt = datetime('now')
      WHERE chainId = ? AND LOWER(address) = LOWER(?)
    `);

    stmt.run(nonce, chainId, address);
  }

  /**
   * Reset nonce tracking for an account.
   * Used when we detect nonce issues and need to re-sync with the network.
   */
  resetNonce(chainId: ChainId, address: string): void {
    const stmt = this.db.prepare(`
      UPDATE accounts
      SET lastUsedNonce = NULL, lastConfirmedNonce = NULL, updatedAt = datetime('now')
      WHERE chainId = ? AND LOWER(address) = LOWER(?)
    `);

    stmt.run(chainId, address);
  }

  /**
   * Get all accounts for a specific chain
   */
  getAccountsByChain(chainId: ChainId): AccountState[] {
    const stmt = this.db.prepare(`
      SELECT * FROM accounts WHERE chainId = ?
    `);

    return (stmt.all(chainId) as any[]).map(row => ({
      chainId: row.chainId,
      address: row.address,
      lastUsedNonce: row.lastUsedNonce,
      lastConfirmedNonce: row.lastConfirmedNonce,
      updatedAt: row.updatedAt
    }));
  }
}