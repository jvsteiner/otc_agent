/**
 * @fileoverview Repository for transaction queue management.
 * Handles queue items for transaction submission with phase-based processing
 * for UTXO chains and critical safeguards against double-spending.
 */

import { QueueItem, QueuePurpose, EscrowAccountRef, ChainId, AssetCode, TxRef } from '@otc-broker/core';
import { DB } from '../database';
import * as crypto from 'crypto';

/**
 * Repository for managing transaction queue items.
 * Ensures sequential processing per sender and prevents conflicting operations.
 */
export class QueueRepository {
  constructor(private db: DB) {}

  /**
   * Enqueues a new transaction for processing.
   * Includes critical safeguards to prevent double-spending.
   * @param item - Queue item data
   * @returns Created queue item with generated ID and sequence
   * @throws Error if conflicting operations detected
   */
  enqueue(item: Omit<QueueItem, 'id' | 'createdAt' | 'seq' | 'status'> & { payoutId?: string }): QueueItem {
    // CRITICAL SAFEGUARD #6: Prevent double-spending by blocking conflicting queue items
    // But allow refunds for CLOSED deals (post-close surplus returns)
    if (item.purpose === 'TIMEOUT_REFUND') {
      // Check if this is a post-close refund (all swaps already completed)
      const existingSwaps = this.getByDeal(item.dealId)
        .filter(q => q.purpose === 'SWAP_PAYOUT' && 
                     q.from.address === item.from.address &&
                     q.asset === item.asset);
      
      // Only block if there are PENDING or SUBMITTED swaps (not COMPLETED ones)
      const pendingSwaps = existingSwaps.filter(s => s.status !== 'COMPLETED');
      
      if (pendingSwaps.length > 0) {
        console.error(`[CRITICAL] Blocked TIMEOUT_REFUND for deal ${item.dealId} - Pending SWAP_PAYOUT exists!`);
        console.error(`  Asset: ${item.asset}, From: ${item.from.address}`);
        console.error(`  Pending swaps: ${pendingSwaps.map(s => `${s.id}:${s.status}`).join(', ')}`);
        throw new Error(`Cannot create refund - pending swap payout exists for ${item.asset}`);
      }
      
      // If all swaps are completed, this is likely a post-close refund which is allowed
      if (existingSwaps.length > 0 && pendingSwaps.length === 0) {
        console.log(`[QueueRepo] Allowing post-close refund for deal ${item.dealId} (all swaps completed)`);
      }
    }
    
    if (item.purpose === 'SWAP_PAYOUT') {
      const existingRefunds = this.getByDeal(item.dealId)
        .filter(q => q.purpose === 'TIMEOUT_REFUND' && 
                     q.from.address === item.from.address &&
                     q.asset === item.asset);
      
      // Only block if there are any refunds (swaps shouldn't happen after refunds)
      if (existingRefunds.length > 0) {
        console.error(`[CRITICAL] Blocked SWAP_PAYOUT for deal ${item.dealId} - TIMEOUT_REFUND exists!`);
        console.error(`  Asset: ${item.asset}, From: ${item.from.address}`);
        console.error(`  Existing refunds: ${existingRefunds.map(r => `${r.id}:${r.status}`).join(', ')}`);
        throw new Error(`Cannot create swap - refund already exists for ${item.asset}`);
      }
    }
    
    // Get next sequence number for this deal+sender
    const seqStmt = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 as nextSeq
      FROM queue_items
      WHERE dealId = ? AND fromAddr = ?
    `);
    
    const seqRow = seqStmt.get(item.dealId, item.from.address) as { nextSeq: number };
    const seq = seqRow.nextSeq;
    
    const id = crypto.randomBytes(16).toString('hex');
    const createdAt = new Date().toISOString();
    
    const { payoutId, ...queueData } = item;
    const queueItem: QueueItem = {
      ...queueData,
      id,
      seq,
      status: 'PENDING',
      createdAt,
    };
    
    const stmt = this.db.prepare(`
      INSERT INTO queue_items (
        id, dealId, chainId, fromAddr, toAddr, 
        asset, amount, purpose, phase, seq, status, createdAt, payoutId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      queueItem.id,
      queueItem.dealId,
      queueItem.chainId,
      queueItem.from.address,
      queueItem.to,
      queueItem.asset,
      queueItem.amount,
      queueItem.purpose,
      queueItem.phase || null,
      queueItem.seq,
      'PENDING',
      queueItem.createdAt,
      payoutId || null
    );
    
    return queueItem;
  }

  getByDeal(dealId: string): QueueItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM queue_items
      WHERE dealId = ?
      ORDER BY fromAddr, seq
    `);
    
    const rows = stmt.all(dealId) as any[];
    return rows.map(row => this.mapRowToQueueItem(row));
  }

  getNextPending(dealId: string, fromAddr: string, phase?: string | null): QueueItem | null {
    // If phase === null, explicitly get non-phased items
    // If phase is a string, get items from that phase
    // If phase is undefined, get all items
    let stmt;
    if (phase === null) {
      stmt = this.db.prepare(`
        SELECT * FROM queue_items
        WHERE dealId = ? AND fromAddr = ? AND status = 'PENDING' AND phase IS NULL
        ORDER BY seq
        LIMIT 1
      `);
    } else if (phase) {
      stmt = this.db.prepare(`
        SELECT * FROM queue_items
        WHERE dealId = ? AND fromAddr = ? AND status = 'PENDING' AND phase = ?
        ORDER BY seq
        LIMIT 1
      `);
    } else {
      stmt = this.db.prepare(`
        SELECT * FROM queue_items
        WHERE dealId = ? AND fromAddr = ? AND status = 'PENDING'
        ORDER BY seq
        LIMIT 1
      `);
    }
    
    const row = phase && phase !== null
      ? stmt.get(dealId, fromAddr, phase) as any
      : stmt.get(dealId, fromAddr) as any;
    if (!row) return null;
    
    return this.mapRowToQueueItem(row);
  }
  
  hasPhaseCompleted(dealId: string, phase: string): boolean {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM queue_items
      WHERE dealId = ? AND phase = ? AND status != 'COMPLETED'
    `);
    
    const row = stmt.get(dealId, phase) as { count: number };
    return row.count === 0;
  }
  
  getPhaseItems(dealId: string, phase: string): QueueItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM queue_items
      WHERE dealId = ? AND phase = ?
      ORDER BY fromAddr, seq
    `);
    
    const rows = stmt.all(dealId, phase) as any[];
    return rows.map(row => this.mapRowToQueueItem(row));
  }

  updateStatus(id: string, status: string, submittedTx?: TxRef): void {
    const stmt = this.db.prepare(`
      UPDATE queue_items
      SET status = ?, submittedTx = ?
      WHERE id = ?
    `);
    
    stmt.run(
      status,
      submittedTx ? JSON.stringify(submittedTx) : null,
      id
    );
  }

  getPendingCount(dealId: string): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM queue_items
      WHERE dealId = ? AND status = 'PENDING'
    `);
    
    const row = stmt.get(dealId) as { count: number };
    return row.count;
  }

  getAll(): QueueItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM queue_items
      ORDER BY createdAt DESC
    `);
    
    const rows = stmt.all() as any[];
    return rows.map(row => this.mapRowToQueueItem(row));
  }
  
  getById(id: string): QueueItem | null {
    const stmt = this.db.prepare('SELECT * FROM queue_items WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return this.mapRowToQueueItem(row);
  }

  /**
   * Update submission metadata for stuck transaction handling
   */
  updateSubmissionMetadata(id: string, metadata: {
    lastSubmitAt?: string;
    originalNonce?: number;
    lastGasPrice?: string;
    gasBumpAttempts?: number;
  }): void {
    // Build dynamic update query based on provided metadata
    const updates: string[] = [];
    const values: any[] = [];

    if (metadata.lastSubmitAt !== undefined) {
      updates.push('lastSubmitAt = ?');
      values.push(metadata.lastSubmitAt);
    }

    if (metadata.originalNonce !== undefined) {
      updates.push('originalNonce = ?');
      values.push(metadata.originalNonce);
    }

    if (metadata.lastGasPrice !== undefined) {
      updates.push('lastGasPrice = ?');
      values.push(metadata.lastGasPrice);
    }

    if (metadata.gasBumpAttempts !== undefined) {
      updates.push('gasBumpAttempts = ?');
      values.push(metadata.gasBumpAttempts);
    }

    if (updates.length === 0) return;

    // Add id at the end for WHERE clause
    values.push(id);

    const query = `UPDATE queue_items SET ${updates.join(', ')} WHERE id = ?`;
    const stmt = this.db.prepare(query);
    stmt.run(...values);
  }

  private mapRowToQueueItem(row: any): QueueItem {
    const item: QueueItem = {
      id: row.id,
      dealId: row.dealId,
      chainId: row.chainId as ChainId,
      from: {
        chainId: row.chainId as ChainId,
        address: row.fromAddr,
      },
      to: row.toAddr,
      asset: row.asset as AssetCode,
      amount: row.amount,
      purpose: row.purpose as QueuePurpose,
      phase: row.phase || undefined,
      seq: row.seq,
      status: row.status,
      createdAt: row.createdAt,
      submittedTx: row.submittedTx ? JSON.parse(row.submittedTx) : undefined,
    };

    // Add gas bump metadata only if present
    if (row.gasBumpAttempts !== undefined) {
      item.gasBumpAttempts = row.gasBumpAttempts;
    }
    if (row.lastSubmitAt) {
      item.lastSubmitAt = row.lastSubmitAt;
    }
    if (row.originalNonce !== undefined) {
      item.originalNonce = row.originalNonce;
    }
    if (row.lastGasPrice) {
      item.lastGasPrice = row.lastGasPrice;
    }

    return item;
  }

  /**
   * Check if a nonce is already in use by another queue item for the same address.
   * Used for sanity checking before submitting transactions.
   *
   * @param chainId - Chain ID
   * @param address - Sender address
   * @param nonce - Nonce to check
   * @param excludeItemId - Optional queue item ID to exclude from check (for updating existing item)
   * @returns The conflicting queue item if found, undefined otherwise
   */
  findNonceConflict(
    chainId: ChainId,
    address: string,
    nonce: string,
    excludeItemId?: string
  ): QueueItem | undefined {
    const allItems = this.getAll();

    return allItems.find(q =>
      q.chainId === chainId &&
      q.from.address.toLowerCase() === address.toLowerCase() &&
      q.status !== 'COMPLETED' &&
      q.id !== excludeItemId &&
      q.submittedTx?.nonceOrInputs === nonce
    );
  }

  /**
   * Get the highest nonce currently queued for an address (PENDING or SUBMITTED).
   * Returns null if no items queued.
   *
   * @param chainId - Chain ID
   * @param address - Sender address
   * @returns Highest nonce or null
   */
  getHighestQueuedNonce(chainId: ChainId, address: string): number | null {
    const allItems = this.getAll();

    const relevantItems = allItems.filter(q =>
      q.chainId === chainId &&
      q.from.address.toLowerCase() === address.toLowerCase() &&
      (q.status === 'PENDING' || q.status === 'SUBMITTED') &&
      q.submittedTx?.nonceOrInputs
    );

    if (relevantItems.length === 0) {
      return null;
    }

    const nonces = relevantItems.map(q => parseInt(q.submittedTx!.nonceOrInputs!));
    return Math.max(...nonces);
  }

  /**
   * Validate that all queued nonces for an address are sequential with no gaps.
   * Returns validation result with any gaps or duplicates found.
   *
   * @param chainId - Chain ID
   * @param address - Sender address
   * @returns Validation result
   */
  validateNonceSequence(chainId: ChainId, address: string): {
    isValid: boolean;
    gaps: number[];
    duplicates: number[];
    nonces: number[];
  } {
    const allItems = this.getAll();

    const relevantItems = allItems.filter(q =>
      q.chainId === chainId &&
      q.from.address.toLowerCase() === address.toLowerCase() &&
      (q.status === 'PENDING' || q.status === 'SUBMITTED') &&
      q.submittedTx?.nonceOrInputs
    );

    if (relevantItems.length === 0) {
      return { isValid: true, gaps: [], duplicates: [], nonces: [] };
    }

    const nonces = relevantItems.map(q => parseInt(q.submittedTx!.nonceOrInputs!)).sort((a, b) => a - b);

    // Check for duplicates
    const duplicates: number[] = [];
    const seen = new Set<number>();
    for (const nonce of nonces) {
      if (seen.has(nonce)) {
        duplicates.push(nonce);
      }
      seen.add(nonce);
    }

    // Check for gaps
    const gaps: number[] = [];
    const minNonce = Math.min(...nonces);
    const maxNonce = Math.max(...nonces);

    for (let i = minNonce; i <= maxNonce; i++) {
      if (!nonces.includes(i)) {
        gaps.push(i);
      }
    }

    return {
      isValid: gaps.length === 0 && duplicates.length === 0,
      gaps,
      duplicates,
      nonces
    };
  }
}