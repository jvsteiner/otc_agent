import { Deal, AssetCode, checkLocks, calculateCommission, getNativeAsset, getAssetMetadata, getConfirmationThreshold, isAmountGte, sumAmounts, subtractAmounts } from '@otc-broker/core';
import { DB } from '../db/database';
import { DealRepository, DepositRepository, QueueRepository, PayoutRepository } from '../db/repositories';
import { PluginManager, ChainPlugin } from '@otc-broker/chains';
import { TankManager, TankConfig } from './TankManager';
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
  private queueRepo: QueueRepository;
  private payoutRepo: PayoutRepository;
  private engineId: string;
  private tankManager?: TankManager;

  constructor(
    private db: DB,
    private pluginManager: PluginManager,
  ) {
    this.dealRepo = new DealRepository(db);
    this.depositRepo = new DepositRepository(db);
    this.queueRepo = new QueueRepository(db);
    this.payoutRepo = new PayoutRepository(db);
    this.engineId = crypto.randomBytes(8).toString('hex');
  }
  
  private async initializeTankManager() {
    const tankPrivateKey = process.env.TANK_WALLET_PRIVATE_KEY;
    if (tankPrivateKey) {
      console.log('[Engine] Initializing Tank Manager for gas funding');
      
      const tankConfig: TankConfig = {
        privateKey: tankPrivateKey,
        fundAmounts: {
          ETH: process.env.ETH_GAS_FUND_AMOUNT || '0.01',
          POLYGON: process.env.POLYGON_GAS_FUND_AMOUNT || '0.5'
        },
        lowThresholds: {
          ETH: process.env.ETH_LOW_GAS_THRESHOLD || '0.1',
          POLYGON: process.env.POLYGON_LOW_GAS_THRESHOLD || '5'
        }
      };
      
      this.tankManager = new TankManager(this.db, tankConfig);
      
      // Initialize tank for configured chains
      const chainConfigs = new Map<string, { rpcUrl: string }>();
      
      // Always configure Ethereum and Polygon with their RPCs (default or configured)
      chainConfigs.set('ETH', { 
        rpcUrl: process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com' 
      });
      chainConfigs.set('POLYGON', { 
        rpcUrl: process.env.POLYGON_RPC || 'https://polygon-rpc.com' 
      });
      
      if (chainConfigs.size > 0) {
        await this.tankManager.init(chainConfigs);
        
        // Inject tank manager into EVM plugins
        for (const [chainId] of chainConfigs) {
          const plugin = this.pluginManager.getPlugin(chainId as any);
          if (plugin && 'setTankManager' in plugin) {
            (plugin as any).setTankManager(this.tankManager);
          }
        }
        
        console.log('[Engine] Tank Manager initialized successfully');
      } else {
        console.log('[Engine] No EVM chains configured for tank manager');
      }
    } else {
      console.log('[Engine] Tank Manager not configured (no TANK_WALLET_PRIVATE_KEY)');
    }
  }

  async start(intervalMs: number = 30000) {
    if (this.running) return;
    
    // Initialize tank manager before starting
    await this.initializeTankManager();
    
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
      // Monitor submitted transactions for confirmation
      await this.monitorSubmittedTransactions();
      
      // Get active deals
      const activeDeals = this.dealRepo.getActiveDeals();
      console.log(`[Engine] Processing ${activeDeals.length} active deals`);
      
      for (const deal of activeDeals) {
        console.log(`[Engine] Processing deal ${deal.id} in stage ${deal.stage}`);
        
        try {
          await this.processDeal(deal);
        } catch (error) {
          console.error(`Error processing deal ${deal.id}:`, error);
          this.dealRepo.addEvent(deal.id, `Engine error: ${error}`);
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
      
      // Check if we can transition from CREATED to COLLECTION
      if (deal.stage === 'CREATED') {
        // Check if both parties have filled their details
        if (deal.aliceDetails && deal.bobDetails) {
          console.log(`Deal ${deal.id}: Both parties have filled details, transitioning to COLLECTION`);
          deal.stage = 'COLLECTION';
          // Set expiry if not already set
          if (!deal.expiresAt) {
            deal.expiresAt = new Date(Date.now() + deal.timeoutSeconds * 1000).toISOString();
          }
          this.dealRepo.update(deal);
          this.dealRepo.addEvent(deal.id, 'Both parties ready, entering collection phase');
        }
      }
      
      // Check locks and transition to WAITING only from COLLECTION stage
      // Clean flow: CREATED → COLLECTION → WAITING
      if (deal.stage === 'COLLECTION') {
        // Check if we have sufficient funds from both sides (regardless of confirmations)
        const sideAFunded = this.hasSufficientFunds(deal, 'A');
        const sideBFunded = this.hasSufficientFunds(deal, 'B');
        
        console.log(`[Engine] Checking funds for deal ${deal.id}:`, {
          sideAFunded,
          sideBFunded,
          sideACollected: deal.sideAState?.collectedByAsset,
          sideBCollected: deal.sideBState?.collectedByAsset
        });
          
          // If both sides have sufficient funds, transition to WAITING immediately
          if (sideAFunded && sideBFunded) {
            console.log(`Deal ${deal.id} has sufficient funds on both sides, transitioning to WAITING`);
            console.log(`  Will wait for confirmations before executing swap`);
            
            // Move to WAITING stage - timer is SUSPENDED (not cleared yet)
            this.dealRepo.updateStage(deal.id, 'WAITING');
            this.dealRepo.addEvent(deal.id, 'Both sides funded, waiting for confirmations (timer suspended)');
            
            // Keep the timer in case we need to revert due to reorg
            console.log(`[Engine] Deal ${deal.id} entered WAITING stage - timer suspended at ${deal.expiresAt}`);
            return; // Process in next tick as WAITING stage
          } else {
            // One or both sides don't have sufficient funds yet
            // Check if timeout expired
            if (deal.expiresAt && new Date() > new Date(deal.expiresAt)) {
              console.log(`Deal ${deal.id} expired without sufficient funds, reverting...`);
              console.log(`  Expiry: ${deal.expiresAt}, Current: ${new Date().toISOString()}`);
              console.log(`  Side A funded: ${sideAFunded}, Side B funded: ${sideBFunded}`);
              await this.revertDeal(deal);
              return;
            } else if (deal.expiresAt) {
              const remainingSeconds = Math.floor((new Date(deal.expiresAt).getTime() - Date.now()) / 1000);
              console.log(`Deal ${deal.id} waiting for deposits, ${remainingSeconds}s remaining`);
            }
          }
        }
      } else if (deal.stage === 'WAITING') {
        // WAITING stage: We have funds but waiting for confirmations
        // Update deposits to get latest confirmation counts
        await this.updateDeposits(deal);
        
        // First check if we still have sufficient funds (reorg detection)
        const sideAFunded = this.hasSufficientFunds(deal, 'A');
        const sideBFunded = this.hasSufficientFunds(deal, 'B');
        
        if (!sideAFunded || !sideBFunded) {
          // REORG DETECTED: Funds dropped below required
          console.error(`[REORG DETECTED] Deal ${deal.id} in WAITING but funds lost!`);
          console.error(`  Side A funded: ${sideAFunded}, Side B funded: ${sideBFunded}`);
          
          // Revert back to COLLECTION stage and resume timer
          this.dealRepo.updateStage(deal.id, 'COLLECTION');
          
          // Resume timer from where it was suspended
          if (!deal.expiresAt) {
            // Timer was cleared, restart with original timeout
            deal.expiresAt = new Date(Date.now() + deal.timeoutSeconds * 1000).toISOString();
            console.log(`[REORG] Restarting timer for deal ${deal.id}, expires at ${deal.expiresAt}`);
          } else {
            console.log(`[REORG] Resuming suspended timer for deal ${deal.id}, expires at ${deal.expiresAt}`);
          }
          
          this.dealRepo.update(deal);
          this.dealRepo.addEvent(deal.id, 'REORG: Funds lost, reverting to COLLECTION (timer resumed)');
          
          // Clear any pending queue items
          const pendingSwaps = this.queueRepo.getByDeal(deal.id)
            .filter(q => q.purpose === 'SWAP_PAYOUT' && q.status === 'PENDING');
          
          if (pendingSwaps.length > 0) {
            console.log(`[REORG] Would clear ${pendingSwaps.length} pending swap queue items`);
            // TODO: Add method to remove pending queue items
          }
          
          return; // Process in next tick as COLLECTION stage
        }
        
        // Funds are still sufficient - check if we have enough confirmations (locks)
        const sideALocked = deal.sideAState?.locks.tradeLockedAt && deal.sideAState?.locks.commissionLockedAt;
        const sideBLocked = deal.sideBState?.locks.tradeLockedAt && deal.sideBState?.locks.commissionLockedAt;
        
        console.log(`[Engine] Deal ${deal.id} in WAITING - checking confirmations:`, {
          sideALocked,
          sideBLocked,
          sideALocks: deal.sideAState?.locks,
          sideBLocks: deal.sideBState?.locks
        });
        
        if (sideALocked && sideBLocked) {
          // Both sides have sufficient confirmations - move to SWAP stage
          console.log(`[Engine] Deal ${deal.id} has confirmed locks, transitioning to SWAP stage`);
          
          // NOW we permanently clear the timer as we enter SWAP stage
          if (deal.expiresAt) {
            console.log(`[Engine] Clearing timer PERMANENTLY for deal ${deal.id} - entering SWAP stage`);
            deal.expiresAt = undefined;
            this.dealRepo.update(deal);
          }
          
          // Build transfer plan and move to SWAP stage
          await this.buildTransferPlan(deal);
          this.dealRepo.updateStage(deal.id, 'SWAP');
          this.dealRepo.addEvent(deal.id, 'Confirmations complete, executing swap (timer removed)');
        } else {
          // Still waiting for confirmations
          console.log(`[Engine] Deal ${deal.id} still waiting for confirmations`);
          console.log(`  Timer suspended at: ${deal.expiresAt || 'not set'}`);
          // Stay in WAITING stage
        }
        
      } else if (deal.stage === 'SWAP') {
        // SWAP stage: Actively executing the swap
        // Timer is PERMANENTLY REMOVED - swap MUST complete
        // IMPORTANT: Funds WILL decrease as we distribute them - this is expected!
        // We do NOT check for "sufficient funds" here as they're being sent out
        
        // Update deposits to track what's left
        await this.updateDeposits(deal);
        
        console.log(`[Engine] Deal ${deal.id} in SWAP stage - executing transfers`);
        
        // Process swap queues
        await this.processQueues(deal);
        
        // Monitor and check transaction confirmations
        const allQueues = this.queueRepo.getByDeal(deal.id);
        let allConfirmed = true;
        
        for (const queueItem of allQueues) {
          if (queueItem.status === 'SUBMITTED' && queueItem.submittedTx) {
            // Check confirmation status
            const plugin = this.pluginManager.getPlugin(queueItem.chainId);
            
            // Get current confirmation count
            const currentConfirms = await plugin.getTxConfirmations(queueItem.submittedTx.txid);
            const requiredConfirms = queueItem.submittedTx.requiredConfirms;
            
            if (currentConfirms === -1) {
              // Transaction disappeared due to reorg!
              console.error(`[REORG] Transaction ${queueItem.submittedTx.txid} disappeared from chain!`);
              this.dealRepo.addEvent(deal.id, `REORG: ${queueItem.purpose} tx disappeared, resubmitting`);
              
              // Reset to PENDING for resubmission
              this.queueRepo.updateStatus(queueItem.id, 'PENDING');
              allConfirmed = false;
            } else if (currentConfirms >= requiredConfirms) {
              this.queueRepo.updateStatus(queueItem.id, 'COMPLETED', queueItem.submittedTx);
              this.dealRepo.addEvent(deal.id, `${queueItem.purpose} confirmed: ${queueItem.submittedTx.txid}`);
            } else {
              allConfirmed = false;
              console.log(`[Engine] Waiting for confirmations on ${queueItem.submittedTx.txid} (${currentConfirms}/${requiredConfirms})`);
            }
          } else if (queueItem.status === 'PENDING') {
            allConfirmed = false;
          }
        }
        
        // Check if all transactions are completed
        if (allConfirmed && allQueues.length > 0 && allQueues.every(q => q.status === 'COMPLETED')) {
          console.log(`[Engine] Deal ${deal.id} all transactions confirmed, marking as CLOSED`);
          this.dealRepo.updateStage(deal.id, 'CLOSED');
          this.dealRepo.addEvent(deal.id, 'All transactions confirmed - deal completed successfully');
        }
      } else if (deal.stage === 'REVERTED') {
        // Process refund queues
        await this.processQueues(deal);
        
        // Monitor refund transaction confirmations
        const allQueues = this.queueRepo.getByDeal(deal.id);
        let allConfirmed = true;
        
        for (const queueItem of allQueues) {
          if (queueItem.status === 'SUBMITTED' && queueItem.submittedTx) {
            const plugin = this.pluginManager.getPlugin(queueItem.chainId);
            const currentConfirms = await plugin.getTxConfirmations(queueItem.submittedTx.txid);
            const requiredConfirms = queueItem.submittedTx.requiredConfirms;
            
            if (currentConfirms === -1) {
              // Refund transaction disappeared - critical!
              console.error(`[CRITICAL REORG] Refund tx ${queueItem.submittedTx.txid} disappeared!`);
              this.dealRepo.addEvent(deal.id, `CRITICAL: Refund tx disappeared, resubmitting`);
              this.queueRepo.updateStatus(queueItem.id, 'PENDING');
              allConfirmed = false;
            } else if (currentConfirms >= requiredConfirms) {
              this.queueRepo.updateStatus(queueItem.id, 'COMPLETED', queueItem.submittedTx);
              this.dealRepo.addEvent(deal.id, `Refund confirmed: ${queueItem.submittedTx.txid}`);
            } else {
              allConfirmed = false;
              console.log(`[Engine] Refund waiting for confirmations (${currentConfirms}/${requiredConfirms})`);
            }
          } else if (queueItem.status === 'PENDING') {
            allConfirmed = false;
          }
        }
        
        // Check if all refunds are complete
        if (allConfirmed && allQueues.length > 0 && allQueues.every(q => q.status === 'COMPLETED')) {
          console.log(`[Engine] Deal ${deal.id} all refunds confirmed, marking as CLOSED`);
          this.dealRepo.updateStage(deal.id, 'CLOSED');
          this.dealRepo.addEvent(deal.id, 'All refunds confirmed - deal closed');
        }
      } else if (deal.stage === 'CLOSED') {
        // Continuously monitor escrows for any funds and return them immediately
        await this.monitorAndReturnEscrowFunds(deal);
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
    
    // Store lock readiness for both sides
    let aliceLockReady = false;
    let bobLockReady = false;
    
    // Update side A deposits
    if (deal.escrowA) {
      const plugin = this.pluginManager.getPlugin(deal.alice.chainId);
      // For CREATED stage, use lower confirmation threshold for visibility
      // For COLLECTION stage, use proper threshold for locking
      const minConf = deal.stage === 'CREATED' ? 1 : getConfirmationThreshold(deal.alice.chainId);
      
      console.log(`[Engine] Checking deposits for Alice (${deal.alice.chainId}):`, {
        asset: deal.alice.asset,
        escrowAddress: deal.escrowA.address,
        minConf,
        stage: deal.stage
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
          minConf  // Use same minConf as trade deposits (1 for CREATED, proper threshold for COLLECTION)
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
      
      // For lock checking, always use the proper confirmation threshold
      const lockMinConf = getConfirmationThreshold(deal.alice.chainId);
      
      const locks = checkLocks(
        allDeposits,
        normalizedAsset, // Use normalized asset for comparison
        deal.alice.amount,
        commissionAsset,
        commissionAmount,
        lockMinConf,  // Use proper threshold for locks
        expiresAt
      );
      
      console.log(`[Engine] Lock check for Alice:`, {
        tradeAmount: deal.alice.amount,
        commissionAmount,
        commissionAsset,
        tradeCollected: locks.tradeCollected,
        commissionCollected: locks.commissionCollected,
        tradeLocked: locks.tradeLocked,
        commissionLocked: locks.commissionLocked,
        minConf: lockMinConf
      });
      
      deal.sideAState.deposits = allDeposits;
      
      // Store lock readiness for Alice (will decide on locks after checking both sides)
      if (deal.stage === 'COLLECTION') {
        aliceLockReady = locks.tradeLocked && locks.commissionLocked;
      }
      
      // In CREATED stage, show all deposits (even with just 1 confirmation)
      // In COLLECTION stage, only show locked amounts (with full confirmations)
      if (deal.stage === 'CREATED') {
        // Sum all deposits for visibility
        const tradeSum = sumAmounts(
          allDeposits
            .filter(d => d.asset === normalizedAsset)
            .map(d => d.amount)
        );
        const commissionSum = sumAmounts(
          allDeposits
            .filter(d => d.asset === commissionAsset)
            .map(d => d.amount)
        );
        deal.sideAState.collectedByAsset[normalizedAsset] = tradeSum;
        if (commissionAsset !== normalizedAsset) {
          deal.sideAState.collectedByAsset[commissionAsset] = commissionSum;
        }
      } else {
        // In COLLECTION stage, use locked amounts only
        deal.sideAState.collectedByAsset[normalizedAsset] = locks.tradeCollected;
        if (commissionAsset !== normalizedAsset) {
          deal.sideAState.collectedByAsset[commissionAsset] = locks.commissionCollected;
        }
      }
    }
    
    // Update side B deposits (similar logic)
    if (deal.escrowB) {
      const plugin = this.pluginManager.getPlugin(deal.bob.chainId);
      // For CREATED stage, use lower confirmation threshold for visibility
      // For COLLECTION stage, use proper threshold for locking
      const minConf = deal.stage === 'CREATED' ? 1 : getConfirmationThreshold(deal.bob.chainId);
      
      console.log(`[Engine] Checking deposits for Bob (${deal.bob.chainId}):`, {
        asset: deal.bob.asset,
        escrowAddress: deal.escrowB.address,
        minConf,
        stage: deal.stage
      });
      
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
          minConf  // Use same minConf as trade deposits (1 for CREATED, proper threshold for COLLECTION)
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
      
      // For lock checking, always use the proper confirmation threshold
      const lockMinConfB = getConfirmationThreshold(deal.bob.chainId);
      
      const locks = checkLocks(
        allDepositsB,
        normalizedAssetB,
        deal.bob.amount,
        commissionAsset,
        commissionAmount,
        lockMinConfB,  // Use proper threshold for locks
        expiresAtB
      );
      
      console.log(`[Engine] Lock check for Bob:`, {
        tradeAmount: deal.bob.amount,
        commissionAmount,
        commissionAsset,
        tradeCollected: locks.tradeCollected,
        commissionCollected: locks.commissionCollected,
        tradeLocked: locks.tradeLocked,
        commissionLocked: locks.commissionLocked,
        minConf: lockMinConfB
      });
      
      deal.sideBState.deposits = allDepositsB;
      
      // Store lock readiness for Bob (will decide on locks after checking both sides)
      if (deal.stage === 'COLLECTION') {
        bobLockReady = locks.tradeLocked && locks.commissionLocked;
      }
      
      // In CREATED stage, show all deposits (even with just 1 confirmation)
      // In COLLECTION stage, only show locked amounts (with full confirmations)
      if (deal.stage === 'CREATED') {
        // Sum all deposits for visibility
        const tradeSum = sumAmounts(
          allDepositsB
            .filter(d => d.asset === normalizedAssetB)
            .map(d => d.amount)
        );
        const commissionSum = sumAmounts(
          allDepositsB
            .filter(d => d.asset === commissionAsset)
            .map(d => d.amount)
        );
        deal.sideBState.collectedByAsset[normalizedAssetB] = tradeSum;
        if (commissionAsset !== normalizedAssetB) {
          deal.sideBState.collectedByAsset[commissionAsset] = commissionSum;
        }
      } else {
        // In COLLECTION stage, use locked amounts only
        deal.sideBState.collectedByAsset[normalizedAssetB] = locks.tradeCollected;
        if (commissionAsset !== normalizedAssetB) {
          deal.sideBState.collectedByAsset[commissionAsset] = locks.commissionCollected;
        }
      }
    }
    
    // NOW decide on locks based on BOTH sides' readiness
    // Only lock if BOTH sides have sufficient funds
    if (deal.stage === 'COLLECTION') {
      if (aliceLockReady && bobLockReady) {
        // BOTH sides have sufficient funds - set locks for both
        console.log(`[Engine] BOTH sides funded - setting locks for Alice AND Bob`);
        
        deal.sideAState.locks = {
          tradeLockedAt: new Date().toISOString(),
          commissionLockedAt: new Date().toISOString(),
        };
        
        deal.sideBState.locks = {
          tradeLockedAt: new Date().toISOString(),
          commissionLockedAt: new Date().toISOString(),
        };
      } else {
        // One or both sides not ready - clear ALL locks
        console.log(`[Engine] Not both sides funded - clearing all locks (Alice ready: ${aliceLockReady}, Bob ready: ${bobLockReady})`);
        
        deal.sideAState.locks = {};
        deal.sideBState.locks = {};
      }
    } else if (deal.stage === 'WAITING') {
      // In WAITING stage, check and update locks based on confirmation status
      if (aliceLockReady && bobLockReady) {
        // Both sides have sufficient confirmations - ensure locks are set
        if (!deal.sideAState.locks.tradeLockedAt) {
          console.log(`[Engine] Setting locks for Alice in WAITING stage`);
          deal.sideAState.locks = {
            tradeLockedAt: new Date().toISOString(),
            commissionLockedAt: new Date().toISOString(),
          };
        }
        if (!deal.sideBState.locks.tradeLockedAt) {
          console.log(`[Engine] Setting locks for Bob in WAITING stage`);
          deal.sideBState.locks = {
            tradeLockedAt: new Date().toISOString(),
            commissionLockedAt: new Date().toISOString(),
          };
        }
      }
      // In WAITING, we don't clear locks even if funds drop (will be handled by reorg detection)
    } else {
      // Not in COLLECTION or WAITING stage - clear all locks
      deal.sideAState.locks = {};
      deal.sideBState.locks = {};
    }
    
    // Update deal in DB
    this.dealRepo.update(deal);
  }

  private async wasEscrowGasFunded(dealId: string, chainId: string, escrow?: any): Promise<boolean> {
    if (!escrow) return false;
    
    try {
      const escrowAddress = typeof escrow === 'string' ? escrow : escrow.address;
      if (!escrowAddress) return false;
      
      // Check if this escrow received gas funding from tank
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM gas_funding 
        WHERE dealId = ? 
        AND chainId = ? 
        AND escrowAddress = ?
        AND status = 'CONFIRMED'
      `);
      
      const result = stmt.get(dealId, chainId, escrowAddress) as { count: number };
      return result.count > 0;
    } catch (error) {
      console.error('Error checking gas funding status:', error);
      return false;
    }
  }
  
  private getTankAddress(): string {
    // Return tank wallet address if configured
    if (this.tankManager) {
      return this.tankManager.getTankAddress();
    }
    return '';
  }
  
  private hasSufficientFunds(deal: Deal, side: 'A' | 'B'): boolean {
    const sideState = side === 'A' ? deal.sideAState : deal.sideBState;
    if (!sideState || !sideState.collectedByAsset) return false;
    
    const tradeSpec = side === 'A' ? deal.alice : deal.bob;
    const commReq = side === 'A' ? deal.commissionPlan.sideA : deal.commissionPlan.sideB;
    
    // Normalize asset code for comparison
    const tradeAsset = normalizeAssetCode(tradeSpec.asset, tradeSpec.chainId);
    const tradeAmount = tradeSpec.amount;
    const tradeCollected = sideState.collectedByAsset[tradeAsset] || '0';
    
    // Calculate commission amount
    const commissionAmount = this.calculateCommissionAmount(deal, side);
    
    // Check based on commission currency type
    if (commReq.currency === 'ASSET') {
      // Commission from same asset - need trade + commission total
      const totalNeeded = sumAmounts([tradeAmount, commissionAmount]);
      return isAmountGte(tradeCollected, totalNeeded);
    } else {
      // Commission from native asset - check both separately
      const nativeAsset = getNativeAsset(tradeSpec.chainId);
      const nativeCollected = sideState.collectedByAsset[nativeAsset] || '0';
      
      return isAmountGte(tradeCollected, tradeAmount) && 
             isAmountGte(nativeCollected, commissionAmount);
    }
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
    console.log(`[Engine] Building transfer plan for deal ${deal.id}`);
    console.log(`[Engine] Deal structure:`, {
      alice: deal.alice,
      bob: deal.bob,
      escrowA: deal.escrowA,
      escrowB: deal.escrowB,
      aliceDetails: !!deal.aliceDetails,
      bobDetails: !!deal.bobDetails
    });
    
    this.db.runInTransaction(() => {
      // Queue swap payouts
      if (deal.escrowA && deal.bobDetails) {
        console.log(`[Engine] Creating Alice->Bob payout queue item`);
        // Create payout for Unicity chains
        let payoutId: string | undefined;
        if (deal.alice.chainId === 'UNICITY') {
          payoutId = this.payoutRepo.createPayout({
            dealId: deal.id,
            chainId: deal.alice.chainId,
            fromAddr: deal.escrowA.address,
            toAddr: deal.bobDetails.recipientAddress,
            asset: deal.alice.asset,
            totalAmount: deal.alice.amount,
            purpose: 'SWAP_PAYOUT',
            phase: 'PHASE_1_SWAP',
            metadata: { side: 'A' }
          });
        }
        
        const queueItem = this.queueRepo.enqueue({
          dealId: deal.id,
          chainId: deal.alice.chainId,
          from: deal.escrowA,
          to: deal.bobDetails.recipientAddress,
          asset: deal.alice.asset,
          amount: deal.alice.amount,
          purpose: 'SWAP_PAYOUT',
          // For Unicity, assign to phase 1
          phase: deal.alice.chainId === 'UNICITY' ? 'PHASE_1_SWAP' : undefined,
        });
        
        // Link queue item to payout for Unicity
        if (payoutId) {
          this.payoutRepo.linkQueueItemToPayout(queueItem.id, payoutId);
        }
      }
      
      if (deal.escrowB && deal.aliceDetails) {
        console.log(`[Engine] Creating Bob->Alice payout queue item:`, {
          bobChainId: deal.bob.chainId,
          bobAsset: deal.bob.asset,
          bobAmount: deal.bob.amount,
          escrowB: deal.escrowB,
          aliceRecipient: deal.aliceDetails.recipientAddress
        });
        
        // Create payout for Unicity chains
        let payoutId: string | undefined;
        if (deal.bob.chainId === 'UNICITY') {
          payoutId = this.payoutRepo.createPayout({
            dealId: deal.id,
            chainId: deal.bob.chainId,
            fromAddr: deal.escrowB.address,
            toAddr: deal.aliceDetails.recipientAddress,
            asset: deal.bob.asset,
            totalAmount: deal.bob.amount,
            purpose: 'SWAP_PAYOUT',
            phase: 'PHASE_1_SWAP',
            metadata: { side: 'B' }
          });
        }
        
        const queueItem = this.queueRepo.enqueue({
          dealId: deal.id,
          chainId: deal.bob.chainId,
          from: deal.escrowB,
          to: deal.aliceDetails.recipientAddress,
          asset: deal.bob.asset,
          amount: deal.bob.amount,
          purpose: 'SWAP_PAYOUT',
          // For Unicity, assign to phase 1
          phase: deal.bob.chainId === 'UNICITY' ? 'PHASE_1_SWAP' : undefined,
        });
        
        // Link queue item to payout for Unicity
        if (payoutId) {
          this.payoutRepo.linkQueueItemToPayout(queueItem.id, payoutId);
        }
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
          // For Unicity, assign to phase 2 (after swap)
          phase: deal.alice.chainId === 'UNICITY' ? 'PHASE_2_COMMISSION' : undefined,
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
          // For Unicity, assign to phase 2 (after swap)
          phase: deal.bob.chainId === 'UNICITY' ? 'PHASE_2_COMMISSION' : undefined,
        });
      }
      
      // Queue surplus refunds (anything left after swap and commission)
      // This ensures we return any overpayments to the users
      if (deal.escrowA && deal.aliceDetails) {
        // Calculate total outgoing from escrow A
        const swapAmount = parseFloat(deal.alice.amount);
        const commissionAmount = parseFloat(sideACommission);
        const totalNeeded = swapAmount + commissionAmount;
        
        // Get total deposits
        const totalDeposited = deal.sideAState?.deposits
          ?.filter(d => d.asset === deal.alice.asset)
          .reduce((sum, d) => sum + parseFloat(d.amount), 0) || 0;
        
        // If there's surplus, queue a refund
        const surplus = totalDeposited - totalNeeded;
        if (surplus > 0.000001) { // Small threshold to avoid dust
          this.queueRepo.enqueue({
            dealId: deal.id,
            chainId: deal.alice.chainId,
            from: deal.escrowA,
            to: deal.aliceDetails.recipientAddress,
            asset: deal.alice.asset,
            amount: surplus.toString(),
            purpose: 'SURPLUS_REFUND',
            // For Unicity, assign to phase 3 (after commission)
            phase: deal.alice.chainId === 'UNICITY' ? 'PHASE_3_REFUND' : undefined,
          });
        }
      }
      
      if (deal.escrowB && deal.bobDetails) {
        // Calculate total outgoing from escrow B
        const swapAmount = parseFloat(deal.bob.amount);
        const commissionAmount = parseFloat(sideBCommission);
        const totalNeeded = swapAmount + commissionAmount;
        
        // Get total deposits
        const totalDeposited = deal.sideBState?.deposits
          ?.filter(d => d.asset === deal.bob.asset)
          .reduce((sum, d) => sum + parseFloat(d.amount), 0) || 0;
        
        // If there's surplus, queue a refund
        const surplus = totalDeposited - totalNeeded;
        if (surplus > 0.000001) { // Small threshold to avoid dust
          this.queueRepo.enqueue({
            dealId: deal.id,
            chainId: deal.bob.chainId,
            from: deal.escrowB,
            to: deal.bobDetails.recipientAddress,
            asset: deal.bob.asset,
            amount: surplus.toString(),
            purpose: 'SURPLUS_REFUND',
            // For Unicity, assign to phase 3 (after commission)
            phase: deal.bob.chainId === 'UNICITY' ? 'PHASE_3_REFUND' : undefined,
          });
        }
      }
      
      this.dealRepo.addEvent(deal.id, 'Transfer plan created');
    });
  }

  private async revertDeal(deal: Deal) {
    // CRITICAL SAFEGUARD #1: Never revert if BOTH sides are locked
    const sideALocked = deal.sideAState?.locks.tradeLockedAt && deal.sideAState?.locks.commissionLockedAt;
    const sideBLocked = deal.sideBState?.locks.tradeLockedAt && deal.sideBState?.locks.commissionLockedAt;
    
    if (sideALocked && sideBLocked) {
      console.error(`[CRITICAL] Attempted to revert deal ${deal.id} with BOTH sides locked!`);
      console.error(`  This would cause double-spending - swap MUST execute!`);
      this.dealRepo.addEvent(deal.id, 'CRITICAL: Blocked revert - both sides locked');
      return;
    }
    
    // If only ONE side is locked, we can still revert (the other side didn't fulfill)
    if (sideALocked && !sideBLocked) {
      console.log(`Deal ${deal.id}: Only Alice locked, Bob didn't deposit enough - OK to revert`);
      this.dealRepo.addEvent(deal.id, 'Reverting: Bob failed to lock funds');
    } else if (!sideALocked && sideBLocked) {
      console.log(`Deal ${deal.id}: Only Bob locked, Alice didn't deposit enough - OK to revert`);
      this.dealRepo.addEvent(deal.id, 'Reverting: Alice failed to lock funds');
    }
    
    // CRITICAL SAFEGUARD #2: Never revert if already in WAITING or later stage
    if (deal.stage === 'WAITING' || deal.stage === 'CLOSED') {
      console.error(`[CRITICAL] Attempted to revert deal ${deal.id} in stage ${deal.stage}!`);
      this.dealRepo.addEvent(deal.id, `CRITICAL: Blocked revert in ${deal.stage} stage`);
      return;
    }
    
    // CRITICAL SAFEGUARD #2b: Double-check we're only in CREATED or COLLECTION
    if (deal.stage !== 'CREATED' && deal.stage !== 'COLLECTION') {
      console.error(`[CRITICAL] Unexpected stage for revert: ${deal.stage}`);
      return;
    }
    
    // CRITICAL SAFEGUARD #3: Check if any SWAP_PAYOUT transactions have been executed
    const executedSwapPayouts = this.queueRepo.getByDeal(deal.id)
      .filter(q => q.purpose === 'SWAP_PAYOUT' && (q.status === 'SUBMITTED' || q.status === 'COMPLETED'));
    
    if (executedSwapPayouts.length > 0) {
      console.error(`[CRITICAL] Attempted to revert deal ${deal.id} with ${executedSwapPayouts.length} swap payouts already executed!`);
      this.dealRepo.addEvent(deal.id, 'CRITICAL: Blocked revert - swap payouts already executed');
      return;
    }
    
    console.log(`[Engine] Reverting deal ${deal.id} - no locks detected, safe to refund`);
    
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
    // Check if any chain involved is UTXO-based (Unicity)
    const hasUnicityA = deal.alice.chainId === 'UNICITY';
    const hasUnicityB = deal.bob.chainId === 'UNICITY';
    const hasUnicity = hasUnicityA || hasUnicityB;
    
    if (hasUnicity) {
      // For UTXO chains, process in phases
      await this.processQueuesPhased(deal);
    } else {
      // For account-based chains, process normally
      await this.processQueuesNormal(deal);
    }
  }
  
  private async processQueuesPhased(deal: Deal) {
    // Determine current phase based on what's completed
    let currentPhase: string | undefined;
    
    // Check phase 1 (SWAP)
    const phase1Items = this.queueRepo.getPhaseItems(deal.id, 'PHASE_1_SWAP');
    if (phase1Items.length > 0 && !this.queueRepo.hasPhaseCompleted(deal.id, 'PHASE_1_SWAP')) {
      currentPhase = 'PHASE_1_SWAP';
    } else if (phase1Items.length > 0 && this.queueRepo.hasPhaseCompleted(deal.id, 'PHASE_1_SWAP')) {
      // Phase 1 complete, check phase 2
      const phase2Items = this.queueRepo.getPhaseItems(deal.id, 'PHASE_2_COMMISSION');
      if (phase2Items.length > 0 && !this.queueRepo.hasPhaseCompleted(deal.id, 'PHASE_2_COMMISSION')) {
        currentPhase = 'PHASE_2_COMMISSION';
      } else if (phase2Items.length === 0 || this.queueRepo.hasPhaseCompleted(deal.id, 'PHASE_2_COMMISSION')) {
        // Phase 2 complete or no phase 2 items, check phase 3
        const phase3Items = this.queueRepo.getPhaseItems(deal.id, 'PHASE_3_REFUND');
        if (phase3Items.length > 0 && !this.queueRepo.hasPhaseCompleted(deal.id, 'PHASE_3_REFUND')) {
          currentPhase = 'PHASE_3_REFUND';
        }
      }
    }
    
    if (!currentPhase) {
      // All phases complete or no phased items
      // Process any non-phased items (e.g., from account-based chains)
      await this.processQueuesNormal(deal);
      return;
    }
    
    console.log(`[Engine] Processing phase ${currentPhase} for deal ${deal.id}`);
    
    // Process items from current phase only
    const queues = this.queueRepo.getByDeal(deal.id);
    const senders = new Set(queues.map(q => `${q.chainId}|${q.from.address}`));
    
    for (const senderKey of senders) {
      const [chainId, address] = senderKey.split('|');
      
      // Get next pending item for this sender IN CURRENT PHASE
      const nextItem = this.queueRepo.getNextPending(deal.id, address, currentPhase);
      if (!nextItem) continue;
      
      try {
        // CRITICAL SAFEGUARD #5: Block refunds if swap payouts exist
        if (nextItem.purpose === 'TIMEOUT_REFUND') {
          const swapPayouts = this.queueRepo.getByDeal(deal.id)
            .filter(q => q.purpose === 'SWAP_PAYOUT');
          
          if (swapPayouts.length > 0) {
            console.error(`[CRITICAL] Blocking TIMEOUT_REFUND for deal ${deal.id} - swap payouts exist!`);
            this.dealRepo.addEvent(deal.id, `CRITICAL: Blocked refund - ${swapPayouts.length} swap payouts exist`);
            // Skip this refund to prevent double-spending
            continue;
          }
        }
        
        // Get the full escrow account ref with keyRef from the deal
        let fromAccountWithKey: any = nextItem.from;
        if (deal.escrowA && deal.escrowA.address === address) {
          fromAccountWithKey = { ...deal.escrowA, dealId: deal.id };
        } else if (deal.escrowB && deal.escrowB.address === address) {
          fromAccountWithKey = { ...deal.escrowB, dealId: deal.id };
        }
        
        // Submit transaction
        console.log(`[Engine] Processing queue item:`, {
          itemId: nextItem.id,
          chainId: nextItem.chainId,
          asset: nextItem.asset,
          from: fromAccountWithKey.address,
          to: nextItem.to,
          amount: nextItem.amount,
          purpose: nextItem.purpose,
          CRITICAL: nextItem.purpose === 'TIMEOUT_REFUND' ? 'This is a refund - verify swap not executed!' : undefined
        });
        
        const plugin = this.pluginManager.getPlugin(nextItem.chainId);
        console.log(`[Engine] Using plugin for chain ${nextItem.chainId}: ${plugin.constructor.name}`);
        
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
          additionalTxids: tx.additionalTxids,
        });
        
        this.dealRepo.addEvent(deal.id, `Submitted ${nextItem.purpose} tx (${currentPhase}): ${tx.txid}`);
      } catch (error: any) {
        console.error(`Failed to submit tx for queue item ${nextItem.id}:`, error);
        this.dealRepo.addEvent(deal.id, `Failed to submit ${nextItem.purpose}: ${error.message}`);
      }
    }
  }
  
  private async processQueuesNormal(deal: Deal) {
    // Original implementation for non-UTXO chains
    const queues = this.queueRepo.getByDeal(deal.id);
    const senders = new Set(queues.map(q => `${q.chainId}|${q.from.address}`));
    
    for (const senderKey of senders) {
      const [chainId, address] = senderKey.split('|');
      
      // Get next pending item for this sender (no phase filter)
      const nextItem = this.queueRepo.getNextPending(deal.id, address);
      if (!nextItem) continue;
      
      try {
        // CRITICAL SAFEGUARD #5: Block refunds if swap payouts exist
        if (nextItem.purpose === 'TIMEOUT_REFUND') {
          const swapPayouts = this.queueRepo.getByDeal(deal.id)
            .filter(q => q.purpose === 'SWAP_PAYOUT');
          
          if (swapPayouts.length > 0) {
            console.error(`[CRITICAL] Blocking TIMEOUT_REFUND for deal ${deal.id} - swap payouts exist!`);
            this.dealRepo.addEvent(deal.id, `CRITICAL: Blocked refund - ${swapPayouts.length} swap payouts exist`);
            // Skip this refund to prevent double-spending
            continue;
          }
        }
        
        // Get the full escrow account ref with keyRef from the deal
        let fromAccountWithKey: any = nextItem.from;
        if (deal.escrowA && deal.escrowA.address === address) {
          fromAccountWithKey = { ...deal.escrowA, dealId: deal.id };
        } else if (deal.escrowB && deal.escrowB.address === address) {
          fromAccountWithKey = { ...deal.escrowB, dealId: deal.id };
        }
        
        // Submit transaction
        console.log(`[Engine] Processing queue item:`, {
          itemId: nextItem.id,
          chainId: nextItem.chainId,
          asset: nextItem.asset,
          from: fromAccountWithKey.address,
          to: nextItem.to,
          amount: nextItem.amount,
          purpose: nextItem.purpose,
          CRITICAL: nextItem.purpose === 'TIMEOUT_REFUND' ? 'This is a refund - verify swap not executed!' : undefined
        });
        
        const plugin = this.pluginManager.getPlugin(nextItem.chainId);
        console.log(`[Engine] Using plugin for chain ${nextItem.chainId}: ${plugin.constructor.name}`);
        
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
          additionalTxids: tx.additionalTxids,
        });
        
        this.dealRepo.addEvent(deal.id, `Submitted ${nextItem.purpose} tx: ${tx.txid}`);
      } catch (error: any) {
        console.error(`Failed to submit tx for queue item ${nextItem.id}:`, error);
        this.dealRepo.addEvent(deal.id, `Failed to submit ${nextItem.purpose}: ${error.message}`);
      }
    }
  }

  private async monitorAndReturnEscrowFunds(deal: Deal) {
    // Continuously monitor and return any funds found in escrows
    // This runs even after deal is CLOSED to handle mistaken payments
    
    // CRITICAL SAFEGUARD #4: Check if swap was executed before returning funds
    const swapPayouts = this.queueRepo.getByDeal(deal.id)
      .filter(q => q.purpose === 'SWAP_PAYOUT');
    
    const hasExecutedSwap = swapPayouts.some(q => q.status === 'COMPLETED');
    const hasPartialSwap = swapPayouts.some(q => q.status === 'SUBMITTED');
    
    if (hasExecutedSwap) {
      // Swap was fully executed - only return EXTRA funds sent after the deal
      console.log(`[Engine] Deal ${deal.id} swap was executed, only monitoring for extra deposits`);
    } else if (hasPartialSwap) {
      console.warn(`[Engine] Deal ${deal.id} has partial swap execution - manual intervention may be needed`);
      this.dealRepo.addEvent(deal.id, 'WARNING: Partial swap execution detected - manual review required');
      // Don't auto-return funds when swap is partially executed
      return;
    }
    
    // Check if escrows were gas-funded by tank
    const aliceEscrowGasFunded = await this.wasEscrowGasFunded(deal.id, deal.alice.chainId, deal.escrowA);
    const bobEscrowGasFunded = await this.wasEscrowGasFunded(deal.id, deal.bob.chainId, deal.escrowB);
    
    // Check Alice's escrow for any balances
    if (deal.escrowA && deal.aliceDetails) {
      const plugin = this.pluginManager.getPlugin(deal.alice.chainId);
      const escrowAddress = await plugin.getManagedAddress(deal.escrowA);
      
      // Check for ANY asset balance (not just the deal asset)
      // First check the primary asset
      const aliceAsset = deal.alice.asset;
      const deposits = await plugin.listConfirmedDeposits(
        aliceAsset,
        escrowAddress,
        1 // Min 1 confirmation
      );
      
      const remainingBalance = parseFloat(deposits.totalConfirmed);
      if (remainingBalance > 0.000001) { // Small threshold to avoid dust
        // Check if we already have a pending or submitted return for this escrow
        const existingQueues = this.queueRepo.getByDeal(deal.id)
          .filter(q => q.from.address === escrowAddress && 
                      q.asset === aliceAsset &&
                      (q.status === 'PENDING' || q.status === 'SUBMITTED'));
        
        // Check if we already have a queue item for approximately this amount
        const alreadyQueued = existingQueues.some(q => 
          Math.abs(parseFloat(q.amount) - remainingBalance) < 0.01 // Within 0.01 ALPHA
        );
        
        if (!alreadyQueued) {
          console.log(`[ESCROW MONITOR] Found ${remainingBalance} ${aliceAsset} in Alice's escrow ${escrowAddress}`);
          this.queueRepo.enqueue({
            dealId: deal.id,
            chainId: deal.alice.chainId,
            from: deal.escrowA,
            to: deal.aliceDetails.paybackAddress,
            asset: aliceAsset,
            amount: deposits.totalConfirmed,
            purpose: 'TIMEOUT_REFUND', // Use TIMEOUT_REFUND for post-deal returns
          });
          this.dealRepo.addEvent(deal.id, `Auto-returning ${deposits.totalConfirmed} ${aliceAsset} from Alice's escrow`);
        }
      }
      
      // Also check for native currency if the deal asset wasn't native
      const nativeAsset = getNativeAsset(deal.alice.chainId);
      if (aliceAsset !== nativeAsset) {
        const nativeDeposits = await plugin.listConfirmedDeposits(
          nativeAsset,
          escrowAddress,
          1
        );
        
        const nativeBalance = parseFloat(nativeDeposits.totalConfirmed);
        if (nativeBalance > 0.000001) {
          const existingNativeQueues = this.queueRepo.getByDeal(deal.id)
            .filter(q => q.from.address === escrowAddress && 
                        q.asset === nativeAsset &&
                        (q.status === 'PENDING' || q.status === 'SUBMITTED'));
          
          const alreadyQueued = existingNativeQueues.some(q => 
            Math.abs(parseFloat(q.amount) - nativeBalance) < 0.01
          );
          
          if (!alreadyQueued) {
            // If escrow was gas-funded by tank, return native currency to tank, otherwise to payback address
            const returnAddress = aliceEscrowGasFunded && this.getTankAddress() 
              ? this.getTankAddress() 
              : deal.aliceDetails.paybackAddress;
            
            const purpose = aliceEscrowGasFunded ? 'GAS_REFUND_TO_TANK' : 'TIMEOUT_REFUND';
            
            console.log(`[ESCROW MONITOR] Found ${nativeBalance} ${nativeAsset} (native) in Alice's escrow ${escrowAddress}`);
            console.log(`[ESCROW MONITOR] Returning to: ${aliceEscrowGasFunded ? 'tank wallet' : 'payback address'} (${returnAddress})`);
            
            this.queueRepo.enqueue({
              dealId: deal.id,
              chainId: deal.alice.chainId,
              from: deal.escrowA,
              to: returnAddress,
              asset: nativeAsset,
              amount: nativeDeposits.totalConfirmed,
              purpose: purpose,
            });
            this.dealRepo.addEvent(deal.id, `Auto-returning ${nativeDeposits.totalConfirmed} ${nativeAsset} from Alice's escrow to ${aliceEscrowGasFunded ? 'tank wallet' : 'payback address'}`);
          }
        }
      }
    }
    
    // Check Bob's escrow for any balances
    if (deal.escrowB && deal.bobDetails) {
      const plugin = this.pluginManager.getPlugin(deal.bob.chainId);
      const escrowAddress = await plugin.getManagedAddress(deal.escrowB);
      
      // Check for the primary asset
      const bobAsset = deal.bob.asset;
      const deposits = await plugin.listConfirmedDeposits(
        bobAsset,
        escrowAddress,
        1 // Min 1 confirmation
      );
      
      const remainingBalance = parseFloat(deposits.totalConfirmed);
      if (remainingBalance > 0.000001) { // Small threshold to avoid dust
        // Check if we already have a pending or submitted return for this escrow
        const existingQueues = this.queueRepo.getByDeal(deal.id)
          .filter(q => q.from.address === escrowAddress && 
                      q.asset === bobAsset &&
                      (q.status === 'PENDING' || q.status === 'SUBMITTED') &&
                      Math.abs(parseFloat(q.amount) - remainingBalance) < 0.01);
        
        if (existingQueues.length === 0) {
          console.log(`[ESCROW MONITOR] Found ${remainingBalance} ${bobAsset} in Bob's escrow ${escrowAddress}`);
          console.log(`[ESCROW MONITOR] Bob's payback address: ${deal.bobDetails.paybackAddress}`);
          console.log(`[ESCROW MONITOR] Bob's recipient address: ${deal.bobDetails.recipientAddress}`);
          
          // CRITICAL: Use payback address for refunds, NOT the source address
          if (!deal.bobDetails.paybackAddress) {
            console.error(`[CRITICAL] No payback address for Bob in deal ${deal.id}!`);
            return;
          }
          
          this.queueRepo.enqueue({
            dealId: deal.id,
            chainId: deal.bob.chainId,
            from: deal.escrowB,
            to: deal.bobDetails.paybackAddress, // MUST use payback address
            asset: bobAsset,
            amount: deposits.totalConfirmed,
            purpose: 'TIMEOUT_REFUND', // Use TIMEOUT_REFUND for post-deal returns
          });
          this.dealRepo.addEvent(deal.id, `Auto-returning ${deposits.totalConfirmed} ${bobAsset} to Bob's payback address: ${deal.bobDetails.paybackAddress}`);
        }
      }
      
      // Also check for native currency if the deal asset wasn't native
      const nativeAsset = getNativeAsset(deal.bob.chainId);
      if (bobAsset !== nativeAsset) {
        const nativeDeposits = await plugin.listConfirmedDeposits(
          nativeAsset,
          escrowAddress,
          1
        );
        
        const nativeBalance = parseFloat(nativeDeposits.totalConfirmed);
        if (nativeBalance > 0.000001) {
          const existingNativeQueues = this.queueRepo.getByDeal(deal.id)
            .filter(q => q.from.address === escrowAddress && 
                        q.asset === nativeAsset &&
                        (q.status === 'PENDING' || q.status === 'SUBMITTED'));
          
          const alreadyQueued = existingNativeQueues.some(q => 
            Math.abs(parseFloat(q.amount) - nativeBalance) < 0.01
          );
          
          if (!alreadyQueued) {
            // If escrow was gas-funded by tank, return native currency to tank, otherwise to payback address
            const returnAddress = bobEscrowGasFunded && this.getTankAddress() 
              ? this.getTankAddress() 
              : deal.bobDetails.paybackAddress;
            
            const purpose = bobEscrowGasFunded ? 'GAS_REFUND_TO_TANK' : 'TIMEOUT_REFUND';
            
            console.log(`[ESCROW MONITOR] Found ${nativeBalance} ${nativeAsset} (native) in Bob's escrow ${escrowAddress}`);
            console.log(`[ESCROW MONITOR] Returning to: ${bobEscrowGasFunded ? 'tank wallet' : 'payback address'} (${returnAddress})`);
            
            this.queueRepo.enqueue({
              dealId: deal.id,
              chainId: deal.bob.chainId,
              from: deal.escrowB,
              to: returnAddress,
              asset: nativeAsset,
              amount: nativeDeposits.totalConfirmed,
              purpose: purpose,
            });
            this.dealRepo.addEvent(deal.id, `Auto-returning ${nativeDeposits.totalConfirmed} ${nativeAsset} from Bob's escrow to ${bobEscrowGasFunded ? 'tank wallet' : 'payback address'}`);
          }
        }
      }
    }
    
    // Process any pending queue items for this closed deal
    await this.processQueues(deal);
  }
  
  private async monitorSubmittedTransactions() {
    // Get all SUBMITTED queue items
    const submittedItems = this.queueRepo.getAll()
      .filter(q => q.status === 'SUBMITTED' && q.submittedTx);
    
    // Track payouts that need updating
    const payoutUpdates = new Map<string, number>();
    
    for (const item of submittedItems) {
      try {
        const txRef = item.submittedTx!;
        const plugin = this.pluginManager.getPlugin(item.chainId);
        
        // Check transaction confirmations
        const confirmations = await plugin.getTxConfirmations(txRef.txid);
        
        // For Unicity with multiple txids, check all transactions
        if (item.chainId === 'UNICITY' && txRef.additionalTxids && txRef.additionalTxids.length > 0) {
          const allTxids = [txRef.txid, ...txRef.additionalTxids];
          let minConfirms = confirmations;
          
          // Get confirmations for each transaction
          for (const txid of txRef.additionalTxids) {
            try {
              const txConfirms = await plugin.getTxConfirmations(txid);
              minConfirms = Math.min(minConfirms, txConfirms);
            } catch (err) {
              console.error(`Failed to check confirmations for additional tx ${txid}:`, err);
              minConfirms = 0; // If any tx fails, consider unconfirmed
            }
          }
          
          // Use the minimum confirmations across all transactions
          const effectiveConfirms = minConfirms;
          
          // Track minimum confirmations for payout if this item has a payoutId
          const payoutId = (item as any).payoutId;
          if (payoutId) {
            const currentMin = payoutUpdates.get(payoutId) ?? Infinity;
            payoutUpdates.set(payoutId, Math.min(currentMin, effectiveConfirms));
          }
          
          if (effectiveConfirms >= txRef.requiredConfirms) {
            // All transactions are confirmed
            this.queueRepo.updateStatus(item.id, 'COMPLETED', {
              ...txRef,
              confirms: effectiveConfirms,
              status: 'CONFIRMED'
            });
            
            console.log(`[Engine] Queue item ${item.id} completed: ${item.purpose} (${allTxids.length} txs) confirmed`);
            this.dealRepo.addEvent(item.dealId, `${item.purpose} completed: ${allTxids.length} transactions confirmed`);
          } else {
            // Update with minimum confirmation count
            this.queueRepo.updateStatus(item.id, 'SUBMITTED', {
              ...txRef,
              confirms: effectiveConfirms
            });
          }
        } else {
          // Single transaction (non-Unicity or Unicity with single tx)
          const payoutId = (item as any).payoutId;
          if (payoutId) {
            const currentMin = payoutUpdates.get(payoutId) ?? Infinity;
            payoutUpdates.set(payoutId, Math.min(currentMin, confirmations));
          }
          
          if (confirmations >= txRef.requiredConfirms) {
            // Transaction is confirmed, mark as COMPLETED
            this.queueRepo.updateStatus(item.id, 'COMPLETED', {
              ...txRef,
              confirms: confirmations,
              status: 'CONFIRMED'
            });
            
            console.log(`[Engine] Queue item ${item.id} completed: ${item.purpose} tx ${txRef.txid} confirmed`);
            this.dealRepo.addEvent(item.dealId, `${item.purpose} completed: ${txRef.txid}`);
          } else {
            // Update confirmation count
            this.queueRepo.updateStatus(item.id, 'SUBMITTED', {
              ...txRef,
              confirms: confirmations
            });
          }
        }
      } catch (error) {
        console.error(`Failed to check confirmations for queue item ${item.id}:`, error);
      }
    }
    
    // Update payout minimum confirmations
    for (const [payoutId, minConfirms] of payoutUpdates) {
      try {
        this.payoutRepo.updatePayoutConfirmations(payoutId, minConfirms);
        
        // Check if all queue items for this payout are completed
        const payoutQueueItems = this.payoutRepo.getQueueItemsByPayoutId(payoutId);
        const allCompleted = payoutQueueItems.every(qi => {
          const queueItem = this.queueRepo.getById(qi.id);
          return queueItem?.status === 'COMPLETED';
        });
        
        if (allCompleted && minConfirms >= 6) { // Assuming 6 confirmations for finality
          this.payoutRepo.updatePayoutStatus(payoutId, 'CONFIRMED', minConfirms);
          console.log(`[Engine] Payout ${payoutId} fully confirmed with ${minConfirms} confirmations`);
        } else if (payoutQueueItems.some(qi => {
          const queueItem = this.queueRepo.getById(qi.id);
          return queueItem?.status === 'SUBMITTED';
        })) {
          this.payoutRepo.updatePayoutStatus(payoutId, 'SUBMITTED', minConfirms);
        }
      } catch (error) {
        console.error(`Failed to update payout ${payoutId} status:`, error);
      }
    }
  }
}