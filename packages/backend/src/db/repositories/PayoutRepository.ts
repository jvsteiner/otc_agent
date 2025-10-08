/**
 * @fileoverview Repository for managing payout records for UTXO chains.
 * Tracks multi-transaction payouts and their confirmation status.
 */

import { DB } from '../database';
import { v4 as uuidv4 } from 'uuid';

export interface Payout {
  payoutId: string;
  dealId: string;
  chainId: string;
  fromAddr: string;
  toAddr: string;
  asset: string;
  totalAmount: string;
  purpose: string;
  phase?: string;
  status: 'PENDING' | 'SUBMITTED' | 'CONFIRMED';
  minConfirmations?: number;
  createdAt: string;
  completedAt?: string;
  metadata?: any;
}

/**
 * Repository for managing payouts on UTXO chains.
 * Tracks the relationship between payouts and queue items,
 * and monitors confirmation status across multiple transactions.
 */
export class PayoutRepository {
  constructor(private db: DB) {}

  /**
   * Creates a new payout record.
   * @param params - Payout parameters
   * @returns Generated payout ID
   */
  createPayout(params: Omit<Payout, 'payoutId' | 'createdAt' | 'status'>): string {
    const payoutId = uuidv4();
    const createdAt = new Date().toISOString();
    
    const stmt = this.db.prepare(`
      INSERT INTO payouts (
        payoutId, dealId, chainId, fromAddr, toAddr, asset, 
        totalAmount, purpose, phase, status, createdAt, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      payoutId,
      params.dealId,
      params.chainId,
      params.fromAddr,
      params.toAddr,
      params.asset,
      params.totalAmount,
      params.purpose,
      params.phase || null,
      'PENDING',
      createdAt,
      params.metadata ? JSON.stringify(params.metadata) : null
    );
    
    return payoutId;
  }

  getPayoutById(payoutId: string): Payout | undefined {
    const row = this.db.prepare('SELECT * FROM payouts WHERE payoutId = ?').get(payoutId) as any;
    if (!row) return undefined;
    
    return {
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    };
  }

  getPayoutsByDealId(dealId: string): Payout[] {
    const rows = this.db.prepare('SELECT * FROM payouts WHERE dealId = ? ORDER BY createdAt').all(dealId) as any[];
    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    }));
  }

  updatePayoutStatus(payoutId: string, status: 'SUBMITTED' | 'CONFIRMED', minConfirmations?: number): void {
    const updates: string[] = ['status = ?'];
    const params: any[] = [status];
    
    if (minConfirmations !== undefined) {
      updates.push('minConfirmations = ?');
      params.push(minConfirmations);
    }
    
    if (status === 'CONFIRMED') {
      updates.push('completedAt = ?');
      params.push(new Date().toISOString());
    }
    
    params.push(payoutId);
    
    const stmt = this.db.prepare(`
      UPDATE payouts 
      SET ${updates.join(', ')}
      WHERE payoutId = ?
    `);
    
    stmt.run(...params);
  }

  updatePayoutConfirmations(payoutId: string, minConfirmations: number): void {
    const stmt = this.db.prepare('UPDATE payouts SET minConfirmations = ? WHERE payoutId = ?');
    stmt.run(minConfirmations, payoutId);
  }

  linkQueueItemToPayout(queueItemId: string, payoutId: string): void {
    const stmt = this.db.prepare('UPDATE queue_items SET payoutId = ? WHERE id = ?');
    stmt.run(payoutId, queueItemId);
  }

  getQueueItemsByPayoutId(payoutId: string): any[] {
    return this.db.prepare('SELECT * FROM queue_items WHERE payoutId = ? ORDER BY seq').all(payoutId) as any[];
  }
}