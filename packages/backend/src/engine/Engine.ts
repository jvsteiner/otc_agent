import { Deal, AssetCode, checkLocks, calculateCommission, getNativeAsset, getAssetMetadata, getConfirmationThreshold, isAmountGte, sumAmounts, subtractAmounts } from '@otc-broker/core';
import { DB } from '../db/database';
import { DealRepository, DepositRepository, LeaseRepository, QueueRepository } from '../db/repositories';
import { PluginManager, ChainPlugin } from '@otc-broker/chains';
import * as crypto from 'crypto';

// Helper function to normalize asset codes for comparison
function normalizeAssetCode(asset: string, chainId: string): string {
  // If asset already includes chain suffix, return as is
  if (asset.includes('@')) {
    return asset;
  }
  // Add chain suffix for fully qualified name
  return `${asset}@${chainId}`;
}

export class Engine {
  private running = false;
  private intervalId?: NodeJS.Timeout;
  private dealRepo: DealRepository;
  private depositRepo: DepositRepository;
  private leaseRepo: LeaseRepository;
  private queueRepo: QueueRepository;
  private engineId: string;

  constructor(
    private db: DB,
    private pluginManager: PluginManager,
  ) {
    this.dealRepo = new DealRepository(db);
    this.depositRepo = new DepositRepository(db);
    this.leaseRepo = new LeaseRepository(db);
    this.queueRepo = new QueueRepository(db);
    this.engineId = crypto.randomBytes(8).toString('hex');
  }

  start(intervalMs: number = 30000) {
    if (this.running) return;
    
    this.running = true;
    console.log(`Engine ${this.engineId} starting with ${intervalMs}ms interval`);
    
    // Run immediately, then on interval
    this.processTick();
    this.intervalId = setInterval(() => this.processTick(), intervalMs);
  }

  stop() {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    console.log(`Engine ${this.engineId} stopped`);
  }

  private async processTick() {
    try {
      // Clean up expired leases
      this.leaseRepo.cleanupExpired();
      
      // Get active deals
      const activeDeals = this.dealRepo.getActiveDeals();
      
      for (const deal of activeDeals) {
        // Try to acquire lease
        if (!this.leaseRepo.acquire(deal.id, this.engineId, 90000)) {
          continue; // Another engine is processing this deal
        }
        
        try {
          await this.processDeal(deal);
        } catch (error) {
          console.error(`Error processing deal ${deal.id}:`, error);
          this.dealRepo.addEvent(deal.id, `Engine error: ${error}`);
        } finally {
          // Extend or release lease based on deal state
          if (deal.stage === 'CLOSED' || deal.stage === 'REVERTED') {
            this.leaseRepo.release(deal.id, this.engineId);
          } else {
            this.leaseRepo.extend(deal.id, this.engineId, 90000);
          }
        }
      }
    } catch (error) {
      console.error('Engine tick error:', error);
    }
  }

  private async processDeal(deal: Deal) {
    console.log(`Processing deal ${deal.id} in stage ${deal.stage}`);
    
    // Step 1: Read deposits for both sides (even in CREATED stage to show progress)
    if (deal.stage === 'CREATED' || deal.stage === 'COLLECTION') {
      await this.updateDeposits(deal);
      
      // Only check timeout and locks in COLLECTION stage
      if (deal.stage === 'COLLECTION') {
        // Check if timeout expired
        if (deal.expiresAt && new Date() > new Date(deal.expiresAt)) {
          console.log(`Deal ${deal.id} expired, reverting...`);
          await this.revertDeal(deal);
          return;
        }
        
        // Check if both sides have locks
        const sideALocked = deal.sideAState?.locks.tradeLockedAt && deal.sideAState?.locks.commissionLockedAt;
        const sideBLocked = deal.sideBState?.locks.tradeLockedAt && deal.sideBState?.locks.commissionLockedAt;
        
        if (sideALocked && sideBLocked) {
          console.log(`Deal ${deal.id} both sides locked, planning distribution...`);
          
          // Preflight checks
          if (await this.preflightChecks(deal)) {
            // Build and persist transfer plan
            await this.buildTransferPlan(deal);
            
            // Move to WAITING stage
            this.dealRepo.updateStage(deal.id, 'WAITING');
          }
        }
      }
    } else if (deal.stage === 'WAITING' || deal.stage === 'REVERTED') {
      // Process queues
      await this.processQueues(deal);
      
      // Check if all queues are complete
      const pendingCount = this.queueRepo.getPendingCount(deal.id);
      if (pendingCount === 0) {
        console.log(`Deal ${deal.id} all transfers complete, processing escrow returns...`);
        
        // Before closing, check for remaining balances and return them
        await this.queueEscrowReturns(deal);
        
        // Check again if there are new pending items after queuing returns
        const newPendingCount = this.queueRepo.getPendingCount(deal.id);
        if (newPendingCount === 0) {
          console.log(`Deal ${deal.id} closing...`);
          this.dealRepo.updateStage(deal.id, 'CLOSED');
        }
      }
    }
  }

  private async updateDeposits(deal: Deal) {
    // Initialize state if needed
    if (!deal.sideAState) {
      deal.sideAState = {
        deposits: [],
        collectedByAsset: {},
        locks: {},
      };
    }
    if (!deal.sideBState) {
      deal.sideBState = {
        deposits: [],
        collectedByAsset: {},
        locks: {},
      };
    }
    
    // Update side A deposits
    if (deal.escrowA) {
      const plugin = this.pluginManager.getPlugin(deal.alice.chainId);
      const minConf = getConfirmationThreshold(deal.alice.chainId);
      
      console.log(`[Engine] Checking deposits for Alice (${deal.alice.chainId}):`, {
        asset: deal.alice.asset,
        escrowAddress: deal.escrowA.address,
        minConf
      });
      
      // Get deposits for trade asset (use normalized asset code)
      const normalizedAsset = normalizeAssetCode(deal.alice.asset, deal.alice.chainId);
      const tradeDeposits = await plugin.listConfirmedDeposits(
        normalizedAsset as AssetCode,
        deal.escrowA.address,
        minConf
      );
      
      console.log(`[Engine] Found ${tradeDeposits.deposits.length} deposits for Alice:`, {
        totalConfirmed: tradeDeposits.totalConfirmed,
        deposits: tradeDeposits.deposits
      });
      
      // Store deposits in DB
      for (const deposit of tradeDeposits.deposits) {
        this.depositRepo.upsert(deal.id, deposit, deal.alice.chainId, deal.escrowA.address);
      }
      
      // Get commission deposits if different currency
      let allDeposits = tradeDeposits.deposits;
      if (deal.commissionPlan.sideA.currency === 'NATIVE' && 
          deal.commissionPlan.sideA.mode === 'FIXED_USD_NATIVE') {
        const nativeAsset = getNativeAsset(deal.alice.chainId);
        const commissionDeposits = await plugin.listConfirmedDeposits(
          nativeAsset,
          deal.escrowA.address,
          minConf
        );
        
        for (const deposit of commissionDeposits.deposits) {
          this.depositRepo.upsert(deal.id, deposit, deal.alice.chainId, deal.escrowA.address);
        }
        
        // Combine trade and commission deposits (different assets)
        allDeposits = [...tradeDeposits.deposits, ...commissionDeposits.deposits];
      }
      
      // Check locks
      const commissionAmount = this.calculateCommissionAmount(deal, 'A');
      const commissionAsset = deal.commissionPlan.sideA.currency === 'ASSET' 
        ? normalizedAsset  // Use normalized asset to match deposits
        : getNativeAsset(deal.alice.chainId);
      
      // For CREATED stage, use a far future date as we're just monitoring
      const expiresAt = deal.expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      
      const locks = checkLocks(
        allDeposits,
        normalizedAsset, // Use normalized asset for comparison
        deal.alice.amount,
        commissionAsset,
        commissionAmount,
        minConf,
        expiresAt
      );
      
      deal.sideAState.deposits = allDeposits;
      deal.sideAState.locks = {
        tradeLockedAt: locks.tradeLocked ? new Date().toISOString() : undefined,
        commissionLockedAt: locks.commissionLocked ? new Date().toISOString() : undefined,
      };
      deal.sideAState.collectedByAsset[normalizedAsset] = locks.tradeCollected;
      if (commissionAsset !== normalizedAsset) {
        deal.sideAState.collectedByAsset[commissionAsset] = locks.commissionCollected;
      }
    }
    
    // Update side B deposits (similar logic)
    if (deal.escrowB) {
      const plugin = this.pluginManager.getPlugin(deal.bob.chainId);
      const minConf = getConfirmationThreshold(deal.bob.chainId);
      
      const normalizedAssetB = normalizeAssetCode(deal.bob.asset, deal.bob.chainId);
      const tradeDeposits = await plugin.listConfirmedDeposits(
        normalizedAssetB as AssetCode,
        deal.escrowB.address,
        minConf
      );
      
      for (const deposit of tradeDeposits.deposits) {
        this.depositRepo.upsert(deal.id, deposit, deal.bob.chainId, deal.escrowB.address);
      }
      
      let allDepositsB = tradeDeposits.deposits;
      if (deal.commissionPlan.sideB.currency === 'NATIVE' && 
          deal.commissionPlan.sideB.mode === 'FIXED_USD_NATIVE') {
        const nativeAsset = getNativeAsset(deal.bob.chainId);
        const commissionDeposits = await plugin.listConfirmedDeposits(
          nativeAsset,
          deal.escrowB.address,
          minConf
        );
        
        for (const deposit of commissionDeposits.deposits) {
          this.depositRepo.upsert(deal.id, deposit, deal.bob.chainId, deal.escrowB.address);
        }
        
        // Combine trade and commission deposits (different assets)
        allDepositsB = [...tradeDeposits.deposits, ...commissionDeposits.deposits];
      }
      
      const commissionAmount = this.calculateCommissionAmount(deal, 'B');
      const commissionAsset = deal.commissionPlan.sideB.currency === 'ASSET' 
        ? normalizedAssetB  // Use normalized asset to match deposits
        : getNativeAsset(deal.bob.chainId);
      
      // For CREATED stage, use a far future date as we're just monitoring
      const expiresAtB = deal.expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      
      const locks = checkLocks(
        allDepositsB,
        normalizedAssetB,
        deal.bob.amount,
        commissionAsset,
        commissionAmount,
        minConf,
        expiresAtB
      );
      
      deal.sideBState.deposits = allDepositsB;
      deal.sideBState.locks = {
        tradeLockedAt: locks.tradeLocked ? new Date().toISOString() : undefined,
        commissionLockedAt: locks.commissionLocked ? new Date().toISOString() : undefined,
      };
      deal.sideBState.collectedByAsset[normalizedAssetB] = locks.tradeCollected;
      if (commissionAsset !== normalizedAssetB) {
        deal.sideBState.collectedByAsset[commissionAsset] = locks.commissionCollected;
      }
    }
    
    // Update deal in DB
    this.dealRepo.update(deal);
  }

  private calculateCommissionAmount(deal: Deal, side: 'A' | 'B'): string {
    const commReq = side === 'A' ? deal.commissionPlan.sideA : deal.commissionPlan.sideB;
    const tradeSpec = side === 'A' ? deal.alice : deal.bob;
    
    if (commReq.mode === 'PERCENT_BPS') {
      const metadata = getAssetMetadata(tradeSpec.asset, tradeSpec.chainId);
      const decimals = metadata?.decimals || 18;
      return calculateCommission(tradeSpec.amount, commReq.percentBps!, decimals);
    } else {
      return commReq.nativeFixed || '0';
    }
  }

  private async preflightChecks(deal: Deal): Promise<boolean> {
    // TODO: Implement comprehensive preflight checks
    // - Check native balance for gas
    // - Reserve nonces/UTXOs
    // - Estimate gas costs
    return true;
  }

  private async buildTransferPlan(deal: Deal) {
    this.db.runInTransaction(() => {
      // Queue swap payouts
      if (deal.escrowA && deal.bobDetails) {
        this.queueRepo.enqueue({
          dealId: deal.id,
          chainId: deal.alice.chainId,
          from: deal.escrowA,
          to: deal.bobDetails.recipientAddress,
          asset: deal.alice.asset,
          amount: deal.alice.amount,
          purpose: 'SWAP_PAYOUT',
        });
      }
      
      if (deal.escrowB && deal.aliceDetails) {
        this.queueRepo.enqueue({
          dealId: deal.id,
          chainId: deal.bob.chainId,
          from: deal.escrowB,
          to: deal.aliceDetails.recipientAddress,
          asset: deal.bob.asset,
          amount: deal.bob.amount,
          purpose: 'SWAP_PAYOUT',
        });
      }
      
      // Queue operator commissions
      const sideACommission = this.calculateCommissionAmount(deal, 'A');
      const sideBCommission = this.calculateCommissionAmount(deal, 'B');
      
      if (deal.escrowA && parseFloat(sideACommission) > 0) {
        const commAsset = deal.commissionPlan.sideA.currency === 'ASSET' 
          ? deal.alice.asset 
          : getNativeAsset(deal.alice.chainId);
        
        const plugin = this.pluginManager.getPlugin(deal.alice.chainId);
        this.queueRepo.enqueue({
          dealId: deal.id,
          chainId: deal.alice.chainId,
          from: deal.escrowA,
          to: plugin.getOperatorAddress(),
          asset: commAsset,
          amount: sideACommission,
          purpose: 'OP_COMMISSION',
        });
      }
      
      if (deal.escrowB && parseFloat(sideBCommission) > 0) {
        const commAsset = deal.commissionPlan.sideB.currency === 'ASSET' 
          ? deal.bob.asset 
          : getNativeAsset(deal.bob.chainId);
        
        const plugin = this.pluginManager.getPlugin(deal.bob.chainId);
        this.queueRepo.enqueue({
          dealId: deal.id,
          chainId: deal.bob.chainId,
          from: deal.escrowB,
          to: plugin.getOperatorAddress(),
          asset: commAsset,
          amount: sideBCommission,
          purpose: 'OP_COMMISSION',
        });
      }
      
      // TODO: Queue surplus refunds
      
      this.dealRepo.addEvent(deal.id, 'Transfer plan created');
    });
  }

  private async revertDeal(deal: Deal) {
    this.db.runInTransaction(() => {
      // Queue refunds for all confirmed deposits
      if (deal.escrowA && deal.aliceDetails && deal.sideAState) {
        for (const [asset, amount] of Object.entries(deal.sideAState.collectedByAsset)) {
          if (parseFloat(amount) > 0) {
            this.queueRepo.enqueue({
              dealId: deal.id,
              chainId: deal.alice.chainId,
              from: deal.escrowA,
              to: deal.aliceDetails.paybackAddress,
              asset: asset as any,
              amount,
              purpose: 'TIMEOUT_REFUND',
            });
          }
        }
      }
      
      if (deal.escrowB && deal.bobDetails && deal.sideBState) {
        for (const [asset, amount] of Object.entries(deal.sideBState.collectedByAsset)) {
          if (parseFloat(amount) > 0) {
            this.queueRepo.enqueue({
              dealId: deal.id,
              chainId: deal.bob.chainId,
              from: deal.escrowB,
              to: deal.bobDetails.paybackAddress,
              asset: asset as any,
              amount,
              purpose: 'TIMEOUT_REFUND',
            });
          }
        }
      }
      
      this.dealRepo.updateStage(deal.id, 'REVERTED');
      this.dealRepo.addEvent(deal.id, 'Deal reverted due to timeout');
    });
  }

  private async processQueues(deal: Deal) {
    // Get all unique senders
    const queues = this.queueRepo.getByDeal(deal.id);
    const senders = new Set(queues.map(q => `${q.chainId}|${q.from.address}`));
    
    for (const senderKey of senders) {
      const [chainId, address] = senderKey.split('|');
      
      // Get next pending item for this sender
      const nextItem = this.queueRepo.getNextPending(deal.id, address);
      if (!nextItem) continue;
      
      try {
        // Get the full escrow account ref with keyRef from the deal
        let fromAccountWithKey = nextItem.from;
        if (deal.escrowA && deal.escrowA.address === address) {
          fromAccountWithKey = deal.escrowA;
        } else if (deal.escrowB && deal.escrowB.address === address) {
          fromAccountWithKey = deal.escrowB;
        }
        
        // Submit transaction
        const plugin = this.pluginManager.getPlugin(nextItem.chainId);
        const tx = await plugin.send(
          nextItem.asset,
          fromAccountWithKey,
          nextItem.to,
          nextItem.amount
        );
        
        // Update queue item with tx info
        this.queueRepo.updateStatus(nextItem.id, 'SUBMITTED', {
          txid: tx.txid,
          chainId: nextItem.chainId,
          submittedAt: tx.submittedAt,
          confirms: 0,
          requiredConfirms: getConfirmationThreshold(nextItem.chainId),
          status: 'PENDING',
          nonceOrInputs: tx.nonceOrInputs,
        });
        
        this.dealRepo.addEvent(deal.id, `Submitted ${nextItem.purpose} tx: ${tx.txid}`);
      } catch (error: any) {
        console.error(`Failed to submit tx for queue item ${nextItem.id}:`, error);
        this.dealRepo.addEvent(deal.id, `Failed to submit ${nextItem.purpose}: ${error.message}`);
      }
    }
  }

  private async queueEscrowReturns(deal: Deal) {
    console.log(`Checking for remaining escrow balances for deal ${deal.id}`);
    
    // Check Alice's escrow for remaining balances
    if (deal.escrowA && deal.aliceDetails) {
      const plugin = this.pluginManager.getPlugin(deal.alice.chainId);
      const escrowAddress = await plugin.getManagedAddress(deal.escrowA);
      
      // Get the asset for Alice's side
      const aliceAsset = deal.alice.asset;
      const deposits = await plugin.listConfirmedDeposits(
        aliceAsset,
        escrowAddress,
        1 // Min 1 confirmation
      );
      
      const remainingBalance = parseFloat(deposits.totalConfirmed);
      if (remainingBalance > 0.000001) { // Small threshold to avoid dust
        console.log(`Found ${remainingBalance} ${aliceAsset} remaining in Alice's escrow`);
        this.queueRepo.enqueue({
          dealId: deal.id,
          chainId: deal.alice.chainId,
          from: deal.escrowA,
          to: deal.aliceDetails.paybackAddress,
          asset: aliceAsset,
          amount: deposits.totalConfirmed,
          purpose: 'SWAP_PAYOUT', // Use existing purpose type for returns
        });
        this.dealRepo.addEvent(deal.id, `Queued return of ${deposits.totalConfirmed} ${aliceAsset} from Alice's escrow`);
      }
    }
    
    // Check Bob's escrow for remaining balances
    if (deal.escrowB && deal.bobDetails) {
      const plugin = this.pluginManager.getPlugin(deal.bob.chainId);
      const escrowAddress = await plugin.getManagedAddress(deal.escrowB);
      
      // Get the asset for Bob's side
      const bobAsset = deal.bob.asset;
      const deposits = await plugin.listConfirmedDeposits(
        bobAsset,
        escrowAddress,
        1 // Min 1 confirmation
      );
      
      const remainingBalance = parseFloat(deposits.totalConfirmed);
      if (remainingBalance > 0.000001) { // Small threshold to avoid dust
        console.log(`Found ${remainingBalance} ${bobAsset} remaining in Bob's escrow`);
        this.queueRepo.enqueue({
          dealId: deal.id,
          chainId: deal.bob.chainId,
          from: deal.escrowB,
          to: deal.bobDetails.paybackAddress,
          asset: bobAsset,
          amount: deposits.totalConfirmed,
          purpose: 'SWAP_PAYOUT', // Use existing purpose type for returns
        });
        this.dealRepo.addEvent(deal.id, `Queued return of ${deposits.totalConfirmed} ${bobAsset} from Bob's escrow`);
      }
    }
  }
}