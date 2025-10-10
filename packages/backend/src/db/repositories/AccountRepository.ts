/**
 * @fileoverview Repository for managing account state including nonces for EVM chains.
 * Tracks nonce state per address to prevent nonce collisions during concurrent transactions.
 */

import { ChainId } from '@otc-broker/core';
import { DB } from '../database';

export interface AccountState {
  chainId: ChainId;
  address: string;
  lastUsedNonce: number | null;
  lastConfirmedNonce: number | null;
}

/**
 * Repository for account state management.
 * Handles nonce tracking for EVM chains to ensure serial transaction submission.
 */
export class AccountRepository {
  constructor(private dbWrapper: DB) {}

  private get db() {
    return this.dbWrapper.getDatabase();
  }

  /**
   * Get account state or create if not exists
   */
  getOrCreate(chainId: ChainId, address: string): AccountState {
    const accountId = `${chainId}|${address.toLowerCase()}`;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO accounts (accountId, chainId, address, lastUsedNonce, lastConfirmedNonce)
      VALUES (?, ?, ?, NULL, NULL)
    `);
    stmt.run(accountId, chainId, address.toLowerCase());

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
      lastConfirmedNonce: row.lastConfirmedNonce
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
   * ATOMIC: Reserve the next nonce for a transaction.
   * This method gets the next nonce AND immediately increments it in a single operation.
   * MUST be called within a database transaction to ensure atomicity.
   *
   * @param chainId - Chain ID
   * @param address - Address
   * @param networkNonce - Optional nonce from network (for first transaction)
   * @returns The nonce to use for this transaction
   */
  reserveNextNonce(chainId: ChainId, address: string, networkNonce?: number): number {
    const account = this.getOrCreate(chainId, address);

    let nonceToUse: number;

    if (account.lastUsedNonce !== null) {
      // We have tracking - use next sequential nonce
      nonceToUse = account.lastUsedNonce + 1;
    } else if (networkNonce !== undefined) {
      // First transaction - use network nonce and initialize tracking
      nonceToUse = networkNonce;
      // Initialize lastUsedNonce to networkNonce - 1 so next call returns networkNonce + 1
      this.updateLastUsedNonce(chainId, address, networkNonce - 1);
    } else {
      throw new Error(`Cannot reserve nonce: no tracking and no network nonce provided for ${chainId}:${address}`);
    }

    // Atomically update the lastUsedNonce to reserve this nonce
    this.updateLastUsedNonce(chainId, address, nonceToUse);

    console.log(`[AccountRepo] RESERVED nonce ${nonceToUse} for ${chainId}:${address}`);

    return nonceToUse;
  }

  /**
   * Update the last used nonce after submitting a transaction
   * This should be called atomically with transaction submission
   */
  updateLastUsedNonce(chainId: ChainId, address: string, nonce: number): void {
    try {
      console.log(`[AccountRepo] updateLastUsedNonce called: chainId=${chainId}, address=${address}, nonce=${nonce}`);

      const stmt = this.db.prepare(`
        UPDATE accounts
        SET lastUsedNonce = ?
        WHERE chainId = ? AND LOWER(address) = LOWER(?)
      `);

      const result = stmt.run(nonce, chainId, address);
      console.log(`[AccountRepo] UPDATE result: changes=${result.changes}`);

      if (result.changes === 0) {
        // Account doesn't exist, create it
        console.log(`[AccountRepo] Account not found, creating...`);
        this.getOrCreate(chainId, address);
        const result2 = stmt.run(nonce, chainId, address);
        console.log(`[AccountRepo] Second UPDATE result: changes=${result2.changes}`);
      }
    } catch (error) {
      console.error(`[AccountRepo] ERROR in updateLastUsedNonce:`, error);
      throw error;
    }
  }

  /**
   * Update the last confirmed nonce when a transaction is confirmed
   * This helps with recovery after crashes
   */
  updateLastConfirmedNonce(chainId: ChainId, address: string, nonce: number): void {
    const stmt = this.db.prepare(`
      UPDATE accounts
      SET lastConfirmedNonce = ?
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
      SET lastUsedNonce = NULL, lastConfirmedNonce = NULL
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
      lastConfirmedNonce: row.lastConfirmedNonce
    }));
  }
}