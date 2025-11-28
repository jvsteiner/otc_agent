/**
 * @fileoverview Repository for persistent caching of UTXO vesting classification results.
 * Stores the results of tracing Unicity UTXOs back to their coinbase origin.
 */

import { DB } from '../database';
import { VestingCacheEntry, VestingCacheStore } from '@otc-broker/chains/src/utils/VestingTracer';

/**
 * SQLite-backed persistent cache for UTXO vesting classification.
 * Implements the VestingCacheStore interface for use with VestingTracer.
 */
export class VestingCacheRepository implements VestingCacheStore {
  constructor(private db: DB) {}

  /**
   * Retrieves a cached vesting entry by transaction ID.
   * @param txid - Transaction ID to look up
   * @returns Cached entry or null if not found
   */
  async get(txid: string): Promise<VestingCacheEntry | null> {
    const stmt = this.db.prepare(`
      SELECT txid, is_coinbase, coinbase_block_height, parent_txid,
             vesting_status, traced_at, error_message
      FROM utxo_vesting_cache
      WHERE txid = ?
    `);

    const row = stmt.get(txid) as any;

    if (!row) {
      return null;
    }

    return this.mapRowToEntry(row);
  }

  /**
   * Stores a vesting entry in the cache.
   * Uses INSERT OR REPLACE for idempotency.
   * @param entry - Vesting cache entry to store
   */
  async set(entry: VestingCacheEntry): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO utxo_vesting_cache (
        txid, is_coinbase, coinbase_block_height, parent_txid,
        vesting_status, traced_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.txid,
      entry.isCoinbase ? 1 : 0,
      entry.coinbaseBlockHeight || null,
      entry.parentTxid || null,
      entry.vestingStatus,
      entry.tracedAt,
      entry.errorMessage || null
    );
  }

  /**
   * Stores multiple vesting entries in a single transaction.
   * More efficient for batch updates from tracing chains.
   * @param entries - Array of vesting cache entries to store
   */
  async setMultiple(entries: VestingCacheEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO utxo_vesting_cache (
        txid, is_coinbase, coinbase_block_height, parent_txid,
        vesting_status, traced_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Use runInTransaction for batched inserts
    this.db.runInTransaction(() => {
      for (const entry of entries) {
        stmt.run(
          entry.txid,
          entry.isCoinbase ? 1 : 0,
          entry.coinbaseBlockHeight || null,
          entry.parentTxid || null,
          entry.vestingStatus,
          entry.tracedAt,
          entry.errorMessage || null
        );
      }
    });
  }

  /**
   * Gets entries with failed tracing status for retry.
   * @param limit - Maximum number of entries to return
   * @returns Array of failed entries that can be retried
   */
  getFailedEntries(limit: number = 100): VestingCacheEntry[] {
    const stmt = this.db.prepare(`
      SELECT txid, is_coinbase, coinbase_block_height, parent_txid,
             vesting_status, traced_at, error_message
      FROM utxo_vesting_cache
      WHERE vesting_status = 'tracing_failed'
      ORDER BY traced_at ASC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as any[];
    return rows.map(row => this.mapRowToEntry(row));
  }

  /**
   * Gets entries with pending status (tracing interrupted).
   * @param limit - Maximum number of entries to return
   * @returns Array of pending entries
   */
  getPendingEntries(limit: number = 100): VestingCacheEntry[] {
    const stmt = this.db.prepare(`
      SELECT txid, is_coinbase, coinbase_block_height, parent_txid,
             vesting_status, traced_at, error_message
      FROM utxo_vesting_cache
      WHERE vesting_status = 'pending'
      ORDER BY traced_at ASC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as any[];
    return rows.map(row => this.mapRowToEntry(row));
  }

  /**
   * Deletes entries older than specified days.
   * Used for cache maintenance.
   * @param olderThanDays - Delete entries older than this many days
   * @returns Number of entries deleted
   */
  pruneOldEntries(olderThanDays: number = 90): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    const cutoffIso = cutoffDate.toISOString();

    const stmt = this.db.prepare(`
      DELETE FROM utxo_vesting_cache
      WHERE traced_at < ? AND vesting_status NOT IN ('vested', 'unvested')
    `);

    const result = stmt.run(cutoffIso);
    return result.changes;
  }

  /**
   * Gets cache statistics for monitoring.
   */
  getStats(): {
    total: number;
    vested: number;
    unvested: number;
    pending: number;
    failed: number;
    coinbases: number;
  } {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN vesting_status = 'vested' THEN 1 ELSE 0 END) as vested,
        SUM(CASE WHEN vesting_status = 'unvested' THEN 1 ELSE 0 END) as unvested,
        SUM(CASE WHEN vesting_status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN vesting_status = 'tracing_failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN is_coinbase = 1 THEN 1 ELSE 0 END) as coinbases
      FROM utxo_vesting_cache
    `);

    const row = stmt.get() as any;

    return {
      total: row.total || 0,
      vested: row.vested || 0,
      unvested: row.unvested || 0,
      pending: row.pending || 0,
      failed: row.failed || 0,
      coinbases: row.coinbases || 0,
    };
  }

  /**
   * Maps a database row to a VestingCacheEntry.
   */
  private mapRowToEntry(row: any): VestingCacheEntry {
    return {
      txid: row.txid,
      isCoinbase: row.is_coinbase === 1,
      coinbaseBlockHeight: row.coinbase_block_height || undefined,
      parentTxid: row.parent_txid || undefined,
      vestingStatus: row.vesting_status,
      tracedAt: row.traced_at,
      errorMessage: row.error_message || undefined,
    };
  }
}
