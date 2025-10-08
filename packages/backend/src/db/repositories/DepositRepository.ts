/**
 * @fileoverview Repository for managing escrow deposit records.
 * Tracks confirmed deposits with deduplication by txid/index to prevent double-counting.
 */

import { EscrowDeposit, ChainId, AssetCode } from '@otc-broker/core';
import { DB } from '../database';

/**
 * Repository for tracking confirmed deposits to escrow addresses.
 * Ensures deposits are counted only once using txid/index deduplication.
 */
export class DepositRepository {
  constructor(private db: DB) {}

  /**
   * Inserts or updates a deposit record.
   * @param dealId - Deal identifier
   * @param deposit - Deposit details
   * @param chainId - Chain where deposit occurred
   * @param address - Escrow address that received the deposit
   */
  upsert(dealId: string, deposit: EscrowDeposit, chainId: ChainId, address: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO escrow_deposits (
        dealId, chainId, address, asset, txid, idx, 
        amount, blockHeight, blockTime, confirms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dealId, txid, idx) DO UPDATE SET
        amount = excluded.amount,
        blockHeight = excluded.blockHeight,
        blockTime = excluded.blockTime,
        confirms = excluded.confirms
    `);
    
    stmt.run(
      dealId,
      chainId,
      address,
      deposit.asset,
      deposit.txid,
      deposit.index || 0,
      deposit.amount,
      deposit.blockHeight || null,
      deposit.blockTime || null,
      deposit.confirms
    );
  }

  getByDeal(dealId: string): EscrowDeposit[] {
    const stmt = this.db.prepare(`
      SELECT asset, txid, idx, amount, blockHeight, blockTime, confirms
      FROM escrow_deposits
      WHERE dealId = ?
      ORDER BY blockTime DESC
    `);
    
    const rows = stmt.all(dealId) as any[];
    
    return rows.map(row => ({
      txid: row.txid,
      index: row.idx || undefined,
      amount: row.amount,
      asset: row.asset as AssetCode,
      blockHeight: row.blockHeight || undefined,
      blockTime: row.blockTime || undefined,
      confirms: row.confirms,
    }));
  }

  getByAddress(address: string, asset?: AssetCode): EscrowDeposit[] {
    let stmt;
    if (asset) {
      stmt = this.db.prepare(`
        SELECT asset, txid, idx, amount, blockHeight, blockTime, confirms
        FROM escrow_deposits
        WHERE address = ? AND asset = ?
        ORDER BY blockTime DESC
      `);
      const rows = stmt.all(address, asset) as any[];
      return rows.map(row => this.mapRowToDeposit(row));
    } else {
      stmt = this.db.prepare(`
        SELECT asset, txid, idx, amount, blockHeight, blockTime, confirms
        FROM escrow_deposits
        WHERE address = ?
        ORDER BY blockTime DESC
      `);
      const rows = stmt.all(address) as any[];
      return rows.map(row => this.mapRowToDeposit(row));
    }
  }

  private mapRowToDeposit(row: any): EscrowDeposit {
    return {
      txid: row.txid,
      index: row.idx || undefined,
      amount: row.amount,
      asset: row.asset as AssetCode,
      blockHeight: row.blockHeight || undefined,
      blockTime: row.blockTime || undefined,
      confirms: row.confirms,
    };
  }
}