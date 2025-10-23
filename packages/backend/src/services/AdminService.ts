/**
 * Admin service - business logic for admin dashboard
 */

import { DB } from '../db/database';
import { DealRepository, QueueRepository } from '../db/repositories';
import { PluginManager } from '@otc-broker/chains';
import { Deal, AssetCode, ChainId, QueuePurpose } from '@otc-broker/core';

export class AdminService {
  private dealRepo: DealRepository;
  private queueRepo: QueueRepository;

  constructor(
    private db: DB,
    private pluginManager: PluginManager
  ) {
    this.dealRepo = new DealRepository(db);
    this.queueRepo = new QueueRepository(db);
  }

  /**
   * Get all deals from database
   */
  getAllDeals(): Deal[] {
    const stmt = this.db.prepare(`
      SELECT * FROM deals
      ORDER BY createdAt DESC
    `);

    const rows = stmt.all() as any[];
    return rows.map(row => JSON.parse(row.json));
  }

  /**
   * Get deal details including balances
   */
  async getDealDetails(dealId: string) {
    const deal = this.dealRepo.getById(dealId);
    if (!deal) {
      throw new Error('Deal not found');
    }

    // Get queue items
    const queueItems = this.queueRepo.getByDeal(dealId);

    // Get escrow balances
    const balances: any = {
      alice: null,
      bob: null
    };

    if (deal.escrowA) {
      const pluginA = this.pluginManager.getPlugin(deal.alice.chainId);
      try {
        const depositsView = await pluginA.listConfirmedDeposits(
          deal.alice.asset,
          deal.escrowA.address,
          0 // Get all deposits regardless of confirmations
        );
        balances.alice = {
          address: deal.escrowA.address,
          chainId: deal.alice.chainId,
          totalConfirmed: depositsView.totalConfirmed,
          deposits: depositsView.deposits
        };
      } catch (error) {
        console.error(`[AdminService] Error getting Alice escrow balance:`, error);
        balances.alice = { error: 'Failed to get balance' };
      }
    }

    if (deal.escrowB) {
      const pluginB = this.pluginManager.getPlugin(deal.bob.chainId);
      try {
        const depositsView = await pluginB.listConfirmedDeposits(
          deal.bob.asset,
          deal.escrowB.address,
          0 // Get all deposits regardless of confirmations
        );
        balances.bob = {
          address: deal.escrowB.address,
          chainId: deal.bob.chainId,
          totalConfirmed: depositsView.totalConfirmed,
          deposits: depositsView.deposits
        };
      } catch (error) {
        console.error(`[AdminService] Error getting Bob escrow balance:`, error);
        balances.bob = { error: 'Failed to get balance' };
      }
    }

    return {
      deal,
      queueItems,
      balances
    };
  }

  /**
   * Spend from escrow (emergency manual intervention)
   */
  async spendFromEscrow(params: {
    dealId: string;
    chainId: string;
    escrowAddress: string;
    toAddress: string;
    asset: AssetCode;
    amount: string;
    reason: string;
  }) {
    const { dealId, chainId, escrowAddress, toAddress, asset, amount, reason } = params;

    // Get deal
    const deal = this.dealRepo.getById(dealId);
    if (!deal) {
      throw new Error('Deal not found');
    }

    // Verify escrow belongs to this deal
    const isAliceEscrow = deal.escrowA && deal.escrowA.address === escrowAddress;
    const isBobEscrow = deal.escrowB && deal.escrowB.address === escrowAddress;

    if (!isAliceEscrow && !isBobEscrow) {
      throw new Error('Escrow does not belong to this deal');
    }

    // Get escrow with keyRef
    const escrow = isAliceEscrow ? deal.escrowA : deal.escrowB;
    if (!escrow) {
      throw new Error('Escrow not found');
    }

    // Prevent spending during active swap
    if (deal.stage === 'SWAP') {
      throw new Error('Cannot spend during active swap - wait for SWAP to complete');
    }

    // Create manual queue item using SURPLUS_REFUND purpose (closest to manual intervention)
    const queueItem = this.queueRepo.enqueue({
      dealId,
      chainId: chainId as ChainId,
      from: escrow,
      to: toAddress,
      asset,
      amount,
      purpose: 'SURPLUS_REFUND' as QueuePurpose,
      phase: 'PHASE_3_REFUND',
    });

    // Add event to deal
    this.dealRepo.addEvent(dealId, `Admin manual spend: ${amount} ${asset} to ${toAddress}. Reason: ${reason}`);

    return {
      success: true,
      queueItemId: queueItem.id,
      message: 'Transaction queued for submission'
    };
  }

  /**
   * Get operator balances for all chains
   */
  async getOperatorBalances() {
    const result: any = {
      operators: {}
    };

    // Get configured chains
    const chains: ChainId[] = ['UNICITY', 'ETH', 'POLYGON', 'SEPOLIA', 'BSC', 'BASE'];

    for (const chainId of chains) {
      try {
        const plugin = this.pluginManager.getPlugin(chainId);

        // Get operator address from plugin config
        const operatorAddress = plugin.getOperatorAddress?.();
        if (operatorAddress) {
          // Query operator native balance
          const depositsView = await plugin.listConfirmedDeposits(
            'NATIVE' as AssetCode,
            operatorAddress,
            0
          );

          result.operators[chainId] = {
            address: operatorAddress,
            balance: depositsView.totalConfirmed || '0'
          };
        }
      } catch (error) {
        console.error(`[AdminService] Error getting balances for ${chainId}:`, error);
        result.operators[chainId] = { error: 'Failed to get balance' };
      }
    }

    return result;
  }

  /**
   * Get summary statistics
   */
  getStats() {
    const stmt = this.db.prepare(`
      SELECT
        stage,
        COUNT(*) as count
      FROM deals
      GROUP BY stage
    `);

    const stageCounts = stmt.all() as { stage: string; count: number }[];
    const byStage: Record<string, number> = {};

    for (const row of stageCounts) {
      byStage[row.stage] = row.count;
    }

    // Get total deals
    const totalStmt = this.db.prepare(`SELECT COUNT(*) as total FROM deals`);
    const { total } = totalStmt.get() as { total: number };

    return {
      total,
      byStage
    };
  }
}
