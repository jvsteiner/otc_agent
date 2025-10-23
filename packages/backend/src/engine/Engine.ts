/**
 * @fileoverview Core processing engine for the OTC Broker system.
 * Manages deal lifecycle, monitors deposits, executes transfers, and handles
 * all stage transitions with critical safeguards against double-spending and reorgs.
 * Runs on a 30-second interval with an independent 5-second queue processor.
 */

import { Deal, QueueItem, AssetCode, ChainId, EscrowAccountRef, checkLocks, calculateCommission, getNativeAsset, getAssetMetadata, getConfirmationThreshold, isAmountGte, sumAmounts, subtractAmounts, parseAssetCode } from '@otc-broker/core';
import { DB } from '../db/database';
import { DealRepository, DepositRepository, QueueRepository, PayoutRepository } from '../db/repositories';
import { AccountRepository } from '../db/repositories/AccountRepository';
import { PluginManager, ChainPlugin } from '@otc-broker/chains';
import { TankManager, TankConfig } from './TankManager';
import { ResolutionWorker } from '../workers/ResolutionWorker';
import { GasReimbursementCalculator } from '../services/GasReimbursementCalculator';
import * as crypto from 'crypto';

/**
 * Normalizes asset codes to include chain suffix for consistent comparison.
 * @param asset - The asset code (e.g., "USDT" or "USDT@POLYGON")
 * @param chainId - The chain identifier
 * @returns Fully qualified asset code with chain suffix
 */
function normalizeAssetCode(asset: string, chainId: string): string {
  // If asset already includes chain suffix, return as is
  if (asset.includes('@')) {
    return asset;
  }
  // Add chain suffix for fully qualified name
  return `${asset}@${chainId}`;
}

/**
 * Core processing engine that manages the entire deal lifecycle.
 * Responsibilities include:
 * - Stage transition management (CREATED → COLLECTION → WAITING → SWAP/CLOSED)
 * - Deposit monitoring and confirmation tracking
 * - Lock verification and timer management
 * - Transfer plan building and queue processing
 * - Reorg detection and recovery
 * - Post-close escrow monitoring
 */
export class Engine {
  private running = false;
  private intervalId?: NodeJS.Timeout;
  private dealRepo: DealRepository;
  private depositRepo: DepositRepository;
  private queueRepo: QueueRepository;
  private payoutRepo: PayoutRepository;
  private accountRepo: AccountRepository;
  private engineId: string;
  private tankManager?: TankManager;
  private resolutionWorker?: ResolutionWorker;
  private gasReimbursementCalculator: GasReimbursementCalculator;
  private isProcessingQueues = false;  // Prevent concurrent queue processing
  private queueProcessingInterval?: NodeJS.Timeout;

  constructor(
    private db: DB,
    private pluginManager: PluginManager,
  ) {
    this.dealRepo = new DealRepository(db);
    this.depositRepo = new DepositRepository(db);
    this.queueRepo = new QueueRepository(db);
    this.payoutRepo = new PayoutRepository(db);
    this.accountRepo = new AccountRepository(db);
    this.engineId = crypto.randomBytes(8).toString('hex');
    this.resolutionWorker = new ResolutionWorker(db, pluginManager);
    this.gasReimbursementCalculator = new GasReimbursementCalculator();
  }
  
  private async initializeTankManager() {
    const tankPrivateKey = process.env.TANK_WALLET_PRIVATE_KEY;
    if (tankPrivateKey) {
      console.log('[Engine] Initializing Tank Manager for gas funding');
      
      const tankConfig: TankConfig = {
        privateKey: tankPrivateKey,
        fundAmounts: {
          ETH: process.env.ETH_GAS_FUND_AMOUNT || '0.01',
          POLYGON: process.env.POLYGON_GAS_FUND_AMOUNT || '0.5',
          SEPOLIA: process.env.SEPOLIA_GAS_FUND_AMOUNT || '0.01'
        },
        lowThresholds: {
          ETH: process.env.ETH_LOW_GAS_THRESHOLD || '0.1',
          POLYGON: process.env.POLYGON_LOW_GAS_THRESHOLD || '5',
          SEPOLIA: process.env.SEPOLIA_LOW_GAS_THRESHOLD || '0.1'
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
        rpcUrl: process.env.POLYGON_RPC || 'https://polygon-mainnet.g.alchemy.com/v2/9LkJ1e22_qxEBFxOQ4pD3'
      });

      // Add SEPOLIA testnet for testing
      if (process.env.SEPOLIA_RPC) {
        chainConfigs.set('SEPOLIA', {
          rpcUrl: process.env.SEPOLIA_RPC
        });
      }
      
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

  /**
   * Starts the engine with specified interval for main processing loop.
   * Also starts the independent queue processor with a 5-second interval.
   * @param intervalMs - Main processing loop interval in milliseconds (default: 30000)
   */
  async start(intervalMs: number = 30000) {
    if (this.running) return;

    // Initialize tank manager before starting
    await this.initializeTankManager();

    this.running = true;
    console.log(`Engine ${this.engineId} starting with ${intervalMs}ms interval`);

    // Run immediately, then on interval
    this.processTick();
    this.intervalId = setInterval(() => this.processTick(), intervalMs);

    // Start independent queue processor (runs every 5 seconds)
    this.startQueueProcessor(5000);

    // Start resolution worker for synthetic transaction ID resolution
    if (this.resolutionWorker) {
      console.log('[Engine] Starting ResolutionWorker for synthetic txid resolution');
      this.resolutionWorker.start();
    }
  }

  /**
   * Stops the engine and clears all intervals.
   * Safe to call multiple times.
   */
  stop() {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    if (this.queueProcessingInterval) {
      clearInterval(this.queueProcessingInterval);
      this.queueProcessingInterval = undefined;
    }
    if (this.resolutionWorker) {
      console.log('[Engine] Stopping ResolutionWorker');
      this.resolutionWorker.stop();
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

          // Check for late deposits on closed/reverted deals
          await this.checkForLateDeposits(deal);
        } catch (error) {
          console.error(`Error processing deal ${deal.id}:`, error);
          this.dealRepo.addEvent(deal.id, `Engine error: ${error}`);
        }
      }
    } catch (error) {
      console.error('Engine tick error:', error);
    }
  }

  /**
   * Processes a single deal through its current stage.
   * Handles stage-specific logic and transitions.
   * @param deal - The deal to process
   */
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
        // Note: monitorAndReturnEscrowFunds calls processQueues internally at the end
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
      // For CREATED and COLLECTION stages, accept unconfirmed deposits (0 confirmations)
      // In WAITING stage, use proper threshold for checking locks
      const minConf = (deal.stage === 'CREATED' || deal.stage === 'COLLECTION') ? 0 : getConfirmationThreshold(deal.alice.chainId);
      
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
        // Check if deposit is synthetic (starts with 'erc20-balance-')
        const isSynthetic = deposit.txid.startsWith('erc20-balance-');
        this.depositRepo.upsert(deal.id, deposit, deal.alice.chainId, deal.escrowA.address, isSynthetic);
      }
      
      // Get commission deposits if different currency
      let allDeposits = tradeDeposits.deposits;
      if (deal.commissionPlan.sideA.currency === 'NATIVE' &&
          deal.commissionPlan.sideA.mode === 'FIXED_USD_NATIVE') {
        const nativeAsset = getNativeAsset(deal.alice.chainId);
        const commissionDeposits = await plugin.listConfirmedDeposits(
          nativeAsset,
          deal.escrowA.address,
          minConf  // Use same minConf as trade deposits (0 for CREATED/COLLECTION, proper threshold for WAITING)
        );

        for (const deposit of commissionDeposits.deposits) {
          const isSynthetic = deposit.txid.startsWith('erc20-balance-');
          this.depositRepo.upsert(deal.id, deposit, deal.alice.chainId, deal.escrowA.address, isSynthetic);
        }

        // Combine trade and commission deposits (different assets)
        allDeposits = [...tradeDeposits.deposits, ...commissionDeposits.deposits];
      }
      
      // Check locks
      const commissionAmount = this.calculateCommissionAmount(deal, 'A');
      const commissionAsset = deal.commissionPlan.sideA.currency === 'ASSET'
        ? normalizedAsset  // Use normalized asset to match deposits
        : getNativeAsset(deal.alice.chainId);
      
      // For CREATED and WAITING stages, use a far future date as timer is suspended/not enforced
      // In COLLECTION stage, use the actual expiry time
      const expiresAt = (deal.stage === 'CREATED' || deal.stage === 'WAITING')
        ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
        : (deal.expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString());
      
      // For lock checking, use the plugin's collect confirms configuration
      const alicePlugin = this.pluginManager.getPlugin(deal.alice.chainId);
      const lockMinConf = alicePlugin.getCollectConfirms();
      
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

      // Merge deposits: keep existing + add new unique ones (by txid+index)
      const existingDeposits = deal.sideAState.deposits || [];
      const depositMap = new Map<string, typeof allDeposits[0]>();

      // Add existing deposits to map
      for (const dep of existingDeposits) {
        const key = `${dep.txid}:${dep.index || 0}`;
        depositMap.set(key, dep);
      }

      // Add/update with new deposits
      for (const dep of allDeposits) {
        const key = `${dep.txid}:${dep.index || 0}`;
        depositMap.set(key, dep);  // Overwrites if exists (updates confirms)
      }

      deal.sideAState.deposits = Array.from(depositMap.values());
      
      // Store lock readiness for Alice (will decide on locks after checking both sides)
      if (deal.stage === 'COLLECTION' || deal.stage === 'WAITING') {
        aliceLockReady = locks.tradeLocked && locks.commissionLocked;
      }
      
      // In CREATED and COLLECTION stages, show all deposits (even unconfirmed)
      // In WAITING stage and beyond, use locked amounts only
      if (deal.stage === 'CREATED' || deal.stage === 'COLLECTION') {
        // Sum all deposits for visibility and transition checking
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
        // In WAITING stage and beyond, use locked amounts only
        deal.sideAState.collectedByAsset[normalizedAsset] = locks.tradeCollected;
        if (commissionAsset !== normalizedAsset) {
          deal.sideAState.collectedByAsset[commissionAsset] = locks.commissionCollected;
        }
      }
    }
    
    // Update side B deposits (similar logic)
    if (deal.escrowB) {
      const plugin = this.pluginManager.getPlugin(deal.bob.chainId);
      // For CREATED and COLLECTION stages, accept unconfirmed deposits (0 confirmations)
      // In WAITING stage, use proper threshold for checking locks
      const minConf = (deal.stage === 'CREATED' || deal.stage === 'COLLECTION') ? 0 : getConfirmationThreshold(deal.bob.chainId);
      
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
        const isSynthetic = deposit.txid.startsWith('erc20-balance-');
        this.depositRepo.upsert(deal.id, deposit, deal.bob.chainId, deal.escrowB.address, isSynthetic);
      }
      
      let allDepositsB = tradeDeposits.deposits;
      console.log(`[Engine] Trade deposits for Bob:`, {
        count: tradeDeposits.deposits.length,
        deposits: tradeDeposits.deposits.map(d => ({ txid: d.txid, amount: d.amount, asset: d.asset })),
        totalConfirmed: tradeDeposits.totalConfirmed
      });
      
      if (deal.commissionPlan.sideB.currency === 'NATIVE' && 
          deal.commissionPlan.sideB.mode === 'FIXED_USD_NATIVE') {
        const nativeAsset = getNativeAsset(deal.bob.chainId);
        const commissionDeposits = await plugin.listConfirmedDeposits(
          nativeAsset,
          deal.escrowB.address,
          minConf  // Use same minConf as trade deposits (1 for CREATED, proper threshold for COLLECTION)
        );
        
        for (const deposit of commissionDeposits.deposits) {
          const isSynthetic = deposit.txid.startsWith('erc20-balance-');
          this.depositRepo.upsert(deal.id, deposit, deal.bob.chainId, deal.escrowB.address, isSynthetic);
        }
        
        // Combine trade and commission deposits (different assets)
        allDepositsB = [...tradeDeposits.deposits, ...commissionDeposits.deposits];
      }
      
      const commissionAmount = this.calculateCommissionAmount(deal, 'B');
      const commissionAsset = deal.commissionPlan.sideB.currency === 'ASSET' 
        ? normalizedAssetB  // Use normalized asset to match deposits
        : getNativeAsset(deal.bob.chainId);
      
      // For CREATED and WAITING stages, use a far future date as timer is suspended/not enforced
      // In COLLECTION stage, use the actual expiry time
      const expiresAtB = (deal.stage === 'CREATED' || deal.stage === 'WAITING') 
        ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
        : (deal.expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString());
      
      // For lock checking, use the plugin's collect confirms configuration
      const bobPlugin = this.pluginManager.getPlugin(deal.bob.chainId);
      const lockMinConfB = bobPlugin.getCollectConfirms();
      
      console.log(`[Engine] Calling checkLocks for Bob with:`, {
        depositCount: allDepositsB.length,
        deposits: allDepositsB.map(d => ({ txid: d.txid, amount: d.amount, asset: d.asset })),
        tradeAsset: normalizedAssetB,
        tradeAmount: deal.bob.amount,
        commissionAsset,
        commissionAmount,
        minConf: lockMinConfB
      });
      
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

      // Merge deposits: keep existing + add new unique ones (by txid+index)
      const existingDepositsB = deal.sideBState.deposits || [];
      const depositMapB = new Map<string, typeof allDepositsB[0]>();

      // Add existing deposits to map
      for (const dep of existingDepositsB) {
        const key = `${dep.txid}:${dep.index || 0}`;
        depositMapB.set(key, dep);
      }

      // Add/update with new deposits
      for (const dep of allDepositsB) {
        const key = `${dep.txid}:${dep.index || 0}`;
        depositMapB.set(key, dep);  // Overwrites if exists (updates confirms)
      }

      deal.sideBState.deposits = Array.from(depositMapB.values());
      
      // Store lock readiness for Bob (will decide on locks after checking both sides)
      if (deal.stage === 'COLLECTION' || deal.stage === 'WAITING') {
        bobLockReady = locks.tradeLocked && locks.commissionLocked;
      }
      
      // In CREATED and COLLECTION stages, show all deposits (even unconfirmed)
      // In WAITING stage and beyond, use locked amounts only
      if (deal.stage === 'CREATED' || deal.stage === 'COLLECTION') {
        // Sum all deposits for visibility and transition checking
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
        // In WAITING stage and beyond, use locked amounts only
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

    let baseCommission = '0';

    if (commReq.mode === 'PERCENT_BPS') {
      const metadata = getAssetMetadata(tradeSpec.asset, tradeSpec.chainId);
      const decimals = metadata?.decimals || 18;
      baseCommission = calculateCommission(tradeSpec.amount, commReq.percentBps!, decimals);
    } else if (commReq.mode === 'FIXED_USD_NATIVE') {
      // For ASSET currency, use USD value directly for stablecoins
      if (commReq.currency === 'ASSET') {
        // For stablecoins like USDT, 1 token = $1, so USD value = token amount
        baseCommission = commReq.usdFixed || '0';
      } else {
        // For NATIVE currency, use the calculated native amount
        baseCommission = commReq.nativeFixed || '0';
      }
    }

    // For ERC20 assets, add fixed fee (in swap currency) to cover gas costs
    // Total commission = percentage commission + fixed fee (both in same currency)
    if (tradeSpec.asset.startsWith('ERC20:') && commReq.erc20FixedFee) {
      const totalCommission = sumAmounts([baseCommission, commReq.erc20FixedFee]);
      console.log(`[Commission] ${side} ERC20 total: ${baseCommission} (0.3%) + ${commReq.erc20FixedFee} (fixed) = ${totalCommission}`);
      return totalCommission;
    }

    return baseCommission;
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
      // Calculate commissions first (needed for both broker and non-broker paths)
      const sideACommission = this.calculateCommissionAmount(deal, 'A');
      const sideBCommission = this.calculateCommissionAmount(deal, 'B');

      // Check if we can use broker for Alice's side
      const canUseBrokerForAlice = this.canUseBroker(deal.alice.chainId);

      // Queue swap payouts
      if (deal.escrowA && deal.bobDetails && deal.aliceDetails) {

        if (canUseBrokerForAlice) {
          // Use broker for atomic swap (includes commission and surplus refund)
          console.log(`[Engine] Using broker for Alice->Bob swap in deal ${deal.id}`);
          this.buildBrokerSwapForSide(
            deal,
            'ALICE',
            deal.escrowA,
            deal.bobDetails.recipientAddress,
            deal.aliceDetails.paybackAddress,
            deal.alice.amount,
            sideACommission
          );
        } else {
          // Fall back to queue-based approach
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
      }
      
      // Check if we can use broker for Bob's side
      const canUseBrokerForBob = this.canUseBroker(deal.bob.chainId);

      if (deal.escrowB && deal.aliceDetails && deal.bobDetails) {

        if (canUseBrokerForBob) {
          // Use broker for atomic swap (includes commission and surplus refund)
          console.log(`[Engine] Using broker for Bob->Alice swap in deal ${deal.id}`);
          this.buildBrokerSwapForSide(
            deal,
            'BOB',
            deal.escrowB,
            deal.aliceDetails.recipientAddress,
            deal.bobDetails.paybackAddress,
            deal.bob.amount,
            sideBCommission
          );
        } else {
          // Fall back to queue-based approach
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
      }
      
      // Queue operator commissions (only for non-broker chains)
      // Broker handles commissions atomically in the swap transaction

      if (!canUseBrokerForAlice && deal.escrowA && parseFloat(sideACommission) > 0) {
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

      if (!canUseBrokerForBob && deal.escrowB && parseFloat(sideBCommission) > 0) {
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

      // Queue gas reimbursement (seq 2.5, after commission, before refunds)
      if (deal.gasReimbursement?.status === 'CALCULATED' &&
          deal.gasReimbursement?.calculation?.tokenAmount &&
          deal.gasReimbursement?.token &&
          deal.gasReimbursement?.chainId &&
          deal.gasReimbursement?.escrowSide) {

        const escrow = deal.gasReimbursement.escrowSide === 'A' ? deal.escrowA : deal.escrowB;
        const escrowSideState = deal.gasReimbursement.escrowSide === 'A' ? deal.sideAState : deal.sideBState;

        if (escrow) {
          console.log('[GasReimbursement] Queuing gas reimbursement:', {
            dealId: deal.id,
            token: deal.gasReimbursement.token,
            amount: deal.gasReimbursement.calculation.tokenAmount,
            escrowSide: deal.gasReimbursement.escrowSide
          });

          // Verify escrow has sufficient balance for reimbursement
          const tokenBalance = escrowSideState?.collectedByAsset[deal.gasReimbursement.token] || '0';
          const reimbursementAmount = parseFloat(deal.gasReimbursement.calculation.tokenAmount);

          if (parseFloat(tokenBalance) >= reimbursementAmount) {
            const tankAddress = this.getTankAddress();

            if (!tankAddress) {
              console.error('[GasReimbursement] Tank address not available, skipping reimbursement');
              this.dealRepo.addEvent(deal.id, 'Gas reimbursement skipped: tank address not available');
            } else {
              this.queueRepo.enqueue({
                dealId: deal.id,
                chainId: deal.gasReimbursement.chainId,
                from: escrow,
                to: tankAddress,
                asset: deal.gasReimbursement.token,
                amount: deal.gasReimbursement.calculation.tokenAmount,
                purpose: 'GAS_REIMBURSEMENT',
                // Non-phased (for EVM chains)
                phase: undefined,
              });

              // Update status to queued
              deal.gasReimbursement.status = 'QUEUED';
              this.dealRepo.update(deal);
              this.dealRepo.addEvent(deal.id, `Gas reimbursement queued: ${deal.gasReimbursement.calculation.tokenAmount} ${deal.gasReimbursement.token} to tank`);

              console.log('[GasReimbursement] Successfully queued gas reimbursement');
            }
          } else {
            console.error('[GasReimbursement] Insufficient balance for reimbursement:', {
              tokenBalance,
              reimbursementAmount
            });

            deal.gasReimbursement.status = 'SKIPPED';
            deal.gasReimbursement.skipReason = `Insufficient balance: have ${tokenBalance}, need ${reimbursementAmount}`;
            this.dealRepo.update(deal);
            this.dealRepo.addEvent(deal.id, `Gas reimbursement skipped: insufficient balance`);
          }
        }
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
            to: deal.aliceDetails.paybackAddress,  // Use payback address for refunds!
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
            to: deal.bobDetails.paybackAddress,  // Use payback address for refunds!
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

  /**
   * Ensures an escrow address has sufficient gas for ERC-20 token transfers.
   * This is critical for timeout refunds where the escrow may have depleted its gas.
   */
  private async ensureGasForRefund(
    escrowAddress: string,
    chainId: string,
    dealId: string,
    asset: AssetCode
  ): Promise<boolean> {
    // Only needed for ERC-20 tokens on EVM chains
    const isEVMChain = chainId === 'ETH' || chainId === 'POLYGON';
    const isERC20 = asset.startsWith('ERC20:');

    if (!isEVMChain || !isERC20) {
      return true; // No gas funding needed for native assets or non-EVM chains
    }

    // If tank manager is not configured, log warning but continue
    if (!this.tankManager) {
      console.warn(`No tank manager configured for gas funding`, {
        dealId,
        chainId,
        escrowAddress,
        asset
      });
      return false;
    }

    try {
      // Extract token address from asset code (format: ERC20:0x123...@CHAIN)
      const tokenAddress = asset.split(':')[1]?.split('@')[0] || '0x0000000000000000000000000000000000000000';

      // Estimate gas needed for ERC-20 transfer (with safety margin)
      // Use placeholder values for estimation purposes
      const gasEstimate = await this.tankManager.estimateGasForERC20Transfer(
        chainId,
        tokenAddress,
        escrowAddress, // from
        escrowAddress, // to (placeholder, just for estimation)
        '1000000' // amount (placeholder, just for estimation)
      );
      const requiredGasWei = gasEstimate.totalCostWei;

      // Fund the escrow address with gas
      const txHash = await this.tankManager.fundEscrowForGas(
        dealId,
        chainId,
        escrowAddress,
        requiredGasWei
      );

      if (txHash === 'already-funded') {
        console.info(`Escrow already has sufficient gas`, {
          dealId,
          chainId,
          escrowAddress
        });
        return true;
      }

      console.info(`Funded escrow with gas for refund`, {
        dealId,
        chainId,
        escrowAddress,
        txHash,
        requiredGasWei: requiredGasWei.toString()
      });

      // Add event to deal history
      this.dealRepo.addEvent(dealId,
        `Funded ${escrowAddress} with gas for ${asset} refund on ${chainId} (tx: ${txHash})`
      );

      // Wait a moment for the transaction to be included
      await new Promise(resolve => setTimeout(resolve, 2000));

      return true;
    } catch (error) {
      console.error(`Failed to fund escrow with gas for refund`, {
        dealId,
        chainId,
        escrowAddress,
        asset,
        error: error instanceof Error ? error.message : String(error)
      });

      // Still return false but don't throw - allow refund attempt to proceed
      // User might manually fund the escrow
      return false;
    }
  }

  /**
   * Check if a deal side can use broker for atomic swap/revert.
   * Returns true if the chain has broker methods and broker is configured.
   */
  private canUseBroker(chainId: ChainId): boolean {
    const plugin = this.pluginManager.getPlugin(chainId);

    // Check if plugin has broker methods (swapViaBroker and revertViaBroker)
    const hasBrokerMethods = !!(plugin as any).swapViaBroker && !!(plugin as any).revertViaBroker;

    if (!hasBrokerMethods) {
      return false;
    }

    // CRITICAL: Check if broker is actually configured (not just methods exist)
    if (typeof (plugin as any).isBrokerAvailable === 'function') {
      const isBrokerConfigured = (plugin as any).isBrokerAvailable();
      if (!isBrokerConfigured) {
        console.log(`[Engine] Broker methods exist for ${chainId} but broker contract not configured - using fallback flow`);
        return false;
      }
    }

    // For now, we only support broker on EVM chains
    const evmChains = ['ETH', 'POLYGON', 'BASE', 'BSC', 'SEPOLIA'];
    return evmChains.includes(chainId);
  }

  /**
   * Build a broker swap queue item for a deal side.
   * This creates a single atomic queue item that handles swap + commission + refund.
   */
  private buildBrokerSwapForSide(
    deal: Deal,
    party: 'ALICE' | 'BOB',
    fromEscrow: any,
    toAddress: string,
    paybackAddress: string,
    swapAmount: string,
    commissionAmount: string
  ): void {
    const side = party === 'ALICE' ? deal.alice : deal.bob;
    const plugin = this.pluginManager.getPlugin(side.chainId);

    console.log(`[Engine] Creating broker swap for ${party} in deal ${deal.id}`);

    this.queueRepo.enqueue({
      dealId: deal.id,
      chainId: side.chainId,
      from: fromEscrow,
      to: toAddress, // This is actually not used by broker, but kept for consistency
      asset: side.asset,
      amount: swapAmount,
      purpose: 'BROKER_SWAP',
      phase: 'PHASE_1_SWAP', // Same priority as regular swaps
      payback: paybackAddress,
      recipient: toAddress,
      feeRecipient: plugin.getOperatorAddress(),
      fees: commissionAmount,
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
    
    // Ensure gas funding for ERC-20 refunds BEFORE starting the transaction
    const gasFundingTasks: Promise<void>[] = [];

    // Check Alice's deposits for ERC-20 tokens that need gas
    if (deal.escrowA && deal.aliceDetails && deal.sideAState) {
      for (const [asset, amount] of Object.entries(deal.sideAState.collectedByAsset)) {
        if (parseFloat(amount) > 0) {
          gasFundingTasks.push(
            this.ensureGasForRefund(
              deal.escrowA.address,
              deal.alice.chainId,
              deal.id,
              asset as AssetCode
            ).then(funded => {
              if (!funded) {
                console.warn(`Proceeding with Alice refund despite gas funding failure`, {
                  dealId: deal.id,
                  asset,
                  escrow: deal.escrowA?.address
                });
              }
            })
          );
        }
      }
    }

    // Check Bob's deposits for ERC-20 tokens that need gas
    if (deal.escrowB && deal.bobDetails && deal.sideBState) {
      for (const [asset, amount] of Object.entries(deal.sideBState.collectedByAsset)) {
        if (parseFloat(amount) > 0) {
          gasFundingTasks.push(
            this.ensureGasForRefund(
              deal.escrowB.address,
              deal.bob.chainId,
              deal.id,
              asset as AssetCode
            ).then(funded => {
              if (!funded) {
                console.warn(`Proceeding with Bob refund despite gas funding failure`, {
                  dealId: deal.id,
                  asset,
                  escrow: deal.escrowB?.address
                });
              }
            })
          );
        }
      }
    }

    // Wait for all gas funding operations to complete
    if (gasFundingTasks.length > 0) {
      console.info(`Ensuring gas for ${gasFundingTasks.length} potential ERC-20 refunds`, {
        dealId: deal.id
      });
      await Promise.all(gasFundingTasks);
    }

    this.db.runInTransaction(() => {
      // Check if we can use broker for reverts
      const canUseBrokerForAlice = this.canUseBroker(deal.alice.chainId);
      const canUseBrokerForBob = this.canUseBroker(deal.bob.chainId);

      // Queue refunds for all confirmed deposits
      if (deal.escrowA && deal.aliceDetails && deal.sideAState) {
        const totalCollected = Object.entries(deal.sideAState.collectedByAsset)
          .reduce((sum, [_, amt]) => sum + parseFloat(amt), 0);

        if (totalCollected > 0 && canUseBrokerForAlice) {
          // Use broker for atomic revert (refund + commission)
          const sideACommission = this.calculateCommissionAmount(deal, 'A');
          const plugin = this.pluginManager.getPlugin(deal.alice.chainId);

          console.log(`[Engine] Using broker for Alice revert in deal ${deal.id}`);
          this.queueRepo.enqueue({
            dealId: deal.id,
            chainId: deal.alice.chainId,
            from: deal.escrowA,
            to: deal.aliceDetails.paybackAddress,
            asset: deal.alice.asset,
            amount: '0', // Amount not used for revert (sends everything)
            purpose: 'BROKER_REVERT',
            phase: 'PHASE_1_SWAP',
            payback: deal.aliceDetails.paybackAddress,
            feeRecipient: plugin.getOperatorAddress(),
            fees: sideACommission,
          });
        } else {
          // Fall back to individual refund queue items
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
      }

      if (deal.escrowB && deal.bobDetails && deal.sideBState) {
        const totalCollected = Object.entries(deal.sideBState.collectedByAsset)
          .reduce((sum, [_, amt]) => sum + parseFloat(amt), 0);

        if (totalCollected > 0 && canUseBrokerForBob) {
          // Use broker for atomic revert (refund + commission)
          const sideBCommission = this.calculateCommissionAmount(deal, 'B');
          const plugin = this.pluginManager.getPlugin(deal.bob.chainId);

          console.log(`[Engine] Using broker for Bob revert in deal ${deal.id}`);
          this.queueRepo.enqueue({
            dealId: deal.id,
            chainId: deal.bob.chainId,
            from: deal.escrowB,
            to: deal.bobDetails.paybackAddress,
            asset: deal.bob.asset,
            amount: '0', // Amount not used for revert (sends everything)
            purpose: 'BROKER_REVERT',
            phase: 'PHASE_1_SWAP',
            payback: deal.bobDetails.paybackAddress,
            feeRecipient: plugin.getOperatorAddress(),
            fees: sideBCommission,
          });
        } else {
          // Fall back to individual refund queue items
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
    console.log(`[Engine] Phase 1 items for deal ${deal.id}:`, phase1Items.length);
    console.log(`[Engine] Phase 1 completed:`, this.queueRepo.hasPhaseCompleted(deal.id, 'PHASE_1_SWAP'));
    
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
    
    // Process non-phased items (for account-based chains like Polygon)
    await this.processQueuesNormal(deal);
    
    if (!currentPhase) {
      // No phased items to process
      return;
    }
    
    console.log(`[Engine] Processing phase ${currentPhase} for deal ${deal.id}`);
    
    // Process items from current phase only
    const queues = this.queueRepo.getByDeal(deal.id);
    const senders = new Set(queues.map(q => `${q.chainId}|${q.from.address}`));
    
    for (const senderKey of senders) {
      const [chainId, address] = senderKey.split('|');

      // Get next pending item for this sender IN CURRENT PHASE
      // CRITICAL: Pass chainId to avoid mixing queue items from different chains (e.g., EVM vs UTXO)
      const nextItem = this.queueRepo.getNextPending(deal.id, address, currentPhase, chainId);
      if (!nextItem) continue;
      
      try {
        // CRITICAL SAFEGUARD #5: Block refunds if UNCOMPLETED swap payouts exist
        // But allow refunds for CLOSED deals (post-close surplus)
        if (nextItem.purpose === 'TIMEOUT_REFUND' && deal.stage !== 'CLOSED') {
          const swapPayouts = this.queueRepo.getByDeal(deal.id)
            .filter(q => q.purpose === 'SWAP_PAYOUT' && q.status !== 'COMPLETED');
          
          if (swapPayouts.length > 0) {
            console.error(`[CRITICAL] Blocking TIMEOUT_REFUND for deal ${deal.id} - uncompleted swap payouts exist!`);
            this.dealRepo.addEvent(deal.id, `CRITICAL: Blocked refund - ${swapPayouts.length} uncompleted swap payouts exist`);
            // Skip this refund to prevent double-spending
            continue;
          }
        }
        
        // UNIFIED SUBMISSION: Use atomic nonce reservation method
        console.log(`[Engine] Processing phased queue item ${nextItem.id} (${currentPhase}: ${nextItem.purpose})`);
        await this.submitQueueItemAtomic(nextItem, deal);
      } catch (error: any) {
        console.error(`Failed to submit tx for queue item ${nextItem.id}:`, error);
        this.dealRepo.addEvent(deal.id, `Failed to submit ${nextItem.purpose}: ${error.message}`);
      }
    }
  }
  
  private async processQueuesNormal(deal: Deal) {
    // Process non-phased items only (for account-based chains)
    const queues = this.queueRepo.getByDeal(deal.id)
      .filter(q => !q.phase); // Only get items without a phase
    const senders = new Set(queues.map(q => `${q.chainId}|${q.from.address}`));
    
    for (const senderKey of senders) {
      const [chainId, address] = senderKey.split('|');

      // Get next pending item for this sender (explicitly NULL phase for non-phased items)
      // CRITICAL: Pass chainId to avoid mixing queue items from different chains (e.g., EVM vs UTXO)
      const nextItem = this.queueRepo.getNextPending(deal.id, address, null, chainId);
      if (!nextItem) continue;
      
      try {
        // CRITICAL SAFEGUARD #5: Block refunds if UNCOMPLETED swap payouts exist
        // But allow refunds for CLOSED deals (post-close surplus)
        if (nextItem.purpose === 'TIMEOUT_REFUND' && deal.stage !== 'CLOSED') {
          const swapPayouts = this.queueRepo.getByDeal(deal.id)
            .filter(q => q.purpose === 'SWAP_PAYOUT' && q.status !== 'COMPLETED');
          
          if (swapPayouts.length > 0) {
            console.error(`[CRITICAL] Blocking TIMEOUT_REFUND for deal ${deal.id} - uncompleted swap payouts exist!`);
            this.dealRepo.addEvent(deal.id, `CRITICAL: Blocked refund - ${swapPayouts.length} uncompleted swap payouts exist`);
            // Skip this refund to prevent double-spending
            continue;
          }
        }
        
        // UNIFIED SUBMISSION: Use atomic nonce reservation method
        console.log(`[Engine] Processing queue item ${nextItem.id} (${nextItem.purpose})`);
        await this.submitQueueItemAtomic(nextItem, deal);
      } catch (error: any) {
        console.error(`Failed to submit tx for queue item ${nextItem.id}:`, error);
        this.dealRepo.addEvent(deal.id, `Failed to submit ${nextItem.purpose}: ${error.message}`);
      }
    }
  }

  /**
   * UNIFIED ATOMIC TRANSACTION SUBMISSION
   * This is the ONLY method that should submit transactions from queue items.
   * Ensures atomic nonce reservation for EVM chains and prevents race conditions.
   *
   * @param item - Queue item to submit
   * @param deal - Deal associated with queue item
   * @returns Transaction reference or throws error
   */
  private async submitQueueItemAtomic(item: QueueItem, deal: Deal): Promise<void> {
    // Get the full escrow account ref with keyRef from the deal
    let fromAccountWithKey: any = item.from;
    if (deal.escrowA && deal.escrowA.address === item.from.address) {
      fromAccountWithKey = deal.escrowA;
    } else if (deal.escrowB && deal.escrowB.address === item.from.address) {
      fromAccountWithKey = deal.escrowB;
    }

    console.log(`[AtomicSubmit] Submitting transaction:`, {
      id: item.id,
      chainId: item.chainId,
      from: item.from.address,
      to: item.to,
      asset: item.asset,
      amount: item.amount,
      purpose: item.purpose,
      phase: item.phase
    });

    // Handle BROKER_SWAP, BROKER_REVERT, and BROKER_REFUND separately (they don't use nonce logic)
    if (item.purpose === 'BROKER_SWAP') {
      return this.submitBrokerSwap(item, deal);
    }

    if (item.purpose === 'BROKER_REVERT') {
      return this.submitBrokerRevert(item, deal);
    }

    if (item.purpose === 'BROKER_REFUND') {
      return this.submitBrokerRefund(item, deal);
    }

    const plugin = this.pluginManager.getPlugin(item.chainId);

    // Prepare transaction options with nonce for EVM chains
    let txOptions: any = undefined;

    // Check if this is an EVM chain (has getCurrentNonce method)
    const isEvmChain = item.chainId === 'ETH' || item.chainId === 'POLYGON';
    if (isEvmChain && 'getCurrentNonce' in plugin) {
      // PRE-VALIDATION: Check queue integrity before reserving nonce
      const validation = this.queueRepo.validateNonceSequence(item.chainId, item.from.address);

      if (!validation.isValid) {
        console.warn(`[AtomicSubmit] Queue integrity check FAILED for ${item.from.address}:`, validation);
        console.warn(`[AtomicSubmit] Gaps: ${validation.gaps.join(', ')}, Duplicates: ${validation.duplicates.join(', ')}`);

        // Don't throw - log and skip this item, it will be retried next cycle
        this.dealRepo.addEvent(deal.id, `Queue integrity issue - gaps: ${validation.gaps.length}, duplicates: ${validation.duplicates.length}`);

        // Reset nonce tracking to recover
        this.accountRepo.resetNonce(item.chainId, item.from.address);
        console.log(`[AtomicSubmit] Reset nonce tracking for ${item.from.address} - will retry next cycle`);

        return; // Skip this item for now
      }

      // ATOMIC nonce reservation with retry logic
      let nonce: number;
      let attempt = 0;
      const maxAttempts = 3;

      while (attempt < maxAttempts) {
        try {
          // Check if we need to fetch initial nonce from network
          const trackedNonce = this.accountRepo.getNextNonce(item.chainId, item.from.address);

          if (trackedNonce === null) {
            // First transaction for this address - fetch from network
            console.log(`[AtomicSubmit] Fetching initial nonce from network for ${item.from.address}`);
            const networkNonce = await (plugin as any).getCurrentNonce(item.from.address);
            console.log(`[AtomicSubmit] Got initial nonce from network: ${networkNonce}`);

            // Reserve nonce atomically with network nonce
            nonce = this.db.runInTransaction(() => {
              return this.accountRepo.reserveNextNonce(item.chainId, item.from.address, networkNonce);
            });
          } else {
            // Validate expected sequence: next nonce should be highest queued + 1
            const highestQueued = this.queueRepo.getHighestQueuedNonce(item.chainId, item.from.address);
            const expectedNonce = highestQueued !== null ? highestQueued + 1 : trackedNonce;

            console.log(`[AtomicSubmit] Expected nonce: ${expectedNonce} (highest queued: ${highestQueued}, tracked: ${trackedNonce})`);

            // Reserve next nonce atomically
            nonce = this.db.runInTransaction(() => {
              return this.accountRepo.reserveNextNonce(item.chainId, item.from.address);
            });

            // VALIDATION: Verify we got the expected nonce
            if (nonce !== expectedNonce) {
              console.warn(`[AtomicSubmit] Nonce mismatch! Expected ${expectedNonce}, got ${nonce}`);
              throw new Error(`Nonce sequence violation: expected ${expectedNonce}, got ${nonce}`);
            }
          }

          console.log(`[AtomicSubmit] ✓ ATOMICALLY reserved nonce ${nonce} for ${item.from.address} (attempt ${attempt + 1})`);
          txOptions = { nonce };
          break; // Success!

        } catch (error: any) {
          attempt++;
          console.error(`[AtomicSubmit] Nonce reservation attempt ${attempt} failed:`, error.message);

          if (attempt < maxAttempts) {
            // Exponential backoff: 100ms, 500ms, 2000ms
            const delay = Math.pow(5, attempt) * 100;
            console.log(`[AtomicSubmit] Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));

            // Reset nonce tracking before retry
            this.accountRepo.resetNonce(item.chainId, item.from.address);
          } else {
            // Max retries exceeded
            console.error(`[AtomicSubmit] Max retry attempts exceeded for ${item.from.address}`);
            this.dealRepo.addEvent(deal.id, `Failed to reserve nonce after ${maxAttempts} attempts`);
            throw error; // Re-throw to trigger error handling
          }
        }
      }
    }

    // BLOCKCHAIN VERIFICATION: Check if deterministic transaction already exists on-chain
    // This prevents double-submission of SWAP_PAYOUT and OP_COMMISSION transactions
    if (item.purpose === 'SWAP_PAYOUT' || item.purpose === 'OP_COMMISSION') {
      console.log(`[AtomicSubmit] Checking blockchain for existing ${item.purpose} transfer...`);

      try {
        const existingTx = await plugin.checkExistingTransfer(
          item.from.address,
          item.to,
          item.asset,
          item.amount
        );

        if (existingTx) {
          console.log(`[AtomicSubmit] ✓ IDEMPOTENCY CHECK: ${item.purpose} already executed on-chain!`);
          console.log(`[AtomicSubmit] Found existing tx: ${existingTx.txid} at block ${existingTx.blockNumber}`);

          // Mark as COMPLETED without submitting (reuse plugin variable from line 1720)
          const txRef: any = {
            txid: existingTx.txid,
            chainId: item.chainId,
            requiredConfirms: plugin.getConfirmationThreshold(),
            submittedAt: new Date().toISOString(),
            confirms: 999, // High number to indicate it's already confirmed
            status: 'COMPLETED',
            nonceOrInputs: txOptions?.nonce?.toString()
          };

          this.queueRepo.updateStatus(item.id, 'COMPLETED', txRef);
          this.dealRepo.addEvent(deal.id, `${item.purpose} already executed (detected via blockchain): ${existingTx.txid.slice(0, 10)}...`);

          console.log(`[AtomicSubmit] Queue item ${item.id} marked COMPLETED (idempotent - already on-chain)`);
          return;
        } else {
          console.log(`[AtomicSubmit] ✓ No existing transfer found - safe to submit`);
        }
      } catch (error: any) {
        console.warn(`[AtomicSubmit] Blockchain verification failed, proceeding with submission:`, error.message);
        // On error, proceed with submission (fail-safe: better to potentially double-submit than block)
      }
    }

    // Submit the transaction with explicit nonce if EVM
    const tx = await plugin.send(
      item.asset,
      fromAccountWithKey,
      item.to,
      item.amount,
      txOptions
    );

    // SANITY CHECK: Verify nonce is not already used by another queue item
    if (isEvmChain && tx.nonceOrInputs) {
      const conflictingItem = this.queueRepo.findNonceConflict(
        item.chainId,
        item.from.address,
        tx.nonceOrInputs,
        item.id
      );

      if (conflictingItem) {
        const error = `CRITICAL: Nonce collision detected! Nonce ${tx.nonceOrInputs} already used by queue item ${conflictingItem.id}`;
        console.error(`[AtomicSubmit] ${error}`);
        console.error(`[AtomicSubmit] Current item: ${item.id} (${item.purpose})`);
        console.error(`[AtomicSubmit] Conflicting item: ${conflictingItem.id} (${conflictingItem.purpose})`);

        this.dealRepo.addEvent(deal.id, `COLLISION: Nonce ${tx.nonceOrInputs} conflict between ${item.purpose} and ${conflictingItem.purpose}`);

        // GRACEFUL RECOVERY: Don't throw, instead reset and retry next cycle
        this.accountRepo.resetNonce(item.chainId, item.from.address);

        // Log full queue state for debugging
        const queueValidation = this.queueRepo.validateNonceSequence(item.chainId, item.from.address);
        console.error(`[AtomicSubmit] Queue state after collision:`, queueValidation);

        // Return without throwing - this will be retried in next engine cycle
        console.log(`[AtomicSubmit] Skipping ${item.id} - will retry in next cycle after nonce reset`);
        return;
      }

      console.log(`[AtomicSubmit] ✓ Nonce ${tx.nonceOrInputs} validation passed - no duplicates found`);
    }

    // Update queue item with tx info (reuse plugin variable from line 1720)
    const txRef: any = {
      txid: tx.txid,
      chainId: item.chainId,
      requiredConfirms: plugin.getConfirmationThreshold(),
      submittedAt: tx.submittedAt,
      confirms: 0,
      status: 'SUBMITTED',
      nonceOrInputs: tx.nonceOrInputs,
      additionalTxids: tx.additionalTxids
    };

    this.queueRepo.updateStatus(item.id, 'SUBMITTED', txRef);

    // Store submission metadata for stuck detection
    this.queueRepo.updateSubmissionMetadata(item.id, {
      lastSubmitAt: new Date().toISOString(),
      originalNonce: txOptions?.nonce,
      lastGasPrice: (tx as any).gasPrice
    });

    this.dealRepo.addEvent(deal.id, `Submitted ${item.purpose} tx: ${tx.txid.slice(0, 10)}...`);

    console.log(`[AtomicSubmit] Transaction submitted successfully:`, {
      queueId: item.id,
      txid: tx.txid,
      nonce: txOptions?.nonce,
      purpose: item.purpose
    });
  }

  /**
   * Submit a broker swap transaction.
   * This is an atomic operation that handles swap + commission + surplus refund.
   */
  private async submitBrokerSwap(item: QueueItem, deal: Deal): Promise<void> {
    console.log(`[BrokerSwap] Submitting broker swap for deal ${deal.id.slice(0, 8)}...`);

    if (!item.recipient || !item.payback || !item.feeRecipient || !item.fees) {
      throw new Error(`Missing broker swap parameters in queue item ${item.id}`);
    }

    const plugin = this.pluginManager.getPlugin(item.chainId);

    if (!(plugin as any).swapViaBroker) {
      throw new Error(`Chain ${item.chainId} does not support broker swaps`);
    }

    // Get the full escrow account ref with keyRef
    let escrowRef = item.from;
    if (deal.escrowA && deal.escrowA.address === item.from.address) {
      escrowRef = deal.escrowA;
    } else if (deal.escrowB && deal.escrowB.address === item.from.address) {
      escrowRef = deal.escrowB;
    }

    // Determine if this is ERC20 or native
    const assetConfig = parseAssetCode(item.asset, item.chainId);
    const currency = assetConfig?.contractAddress; // undefined for native
    const decimals = assetConfig?.decimals; // Token decimals

    console.log(`[BrokerSwap] DEBUG: Asset: ${item.asset}, Currency: ${currency}, Decimals: ${decimals}`);
    console.log(`[BrokerSwap] DEBUG: AssetConfig:`, assetConfig);

    try {
      const result = await (plugin as any).swapViaBroker({
        dealId: item.dealId,
        escrow: escrowRef,
        payback: item.payback,
        recipient: item.recipient,
        feeRecipient: item.feeRecipient,
        amount: item.amount,
        fees: item.fees,
        currency: currency,
        decimals: decimals,
      });

      // Update queue item status (reuse plugin variable from beginning of method)
      const txRef: any = {
        txid: result.txid,
        chainId: item.chainId,
        requiredConfirms: plugin.getConfirmationThreshold(),
        submittedAt: result.submittedAt,
        confirms: 0,
        status: 'SUBMITTED',
        nonceOrInputs: result.nonceOrInputs,
        gasPrice: result.gasPrice,
      };

      this.queueRepo.updateStatus(item.id, 'SUBMITTED', txRef);
      this.dealRepo.addEvent(deal.id, `Broker swap submitted: ${result.txid.slice(0, 10)}...`);

      console.log(`[BrokerSwap] Transaction submitted successfully: ${result.txid}`);
    } catch (error: any) {
      console.error(`[BrokerSwap] Failed to submit broker swap:`, error.message);
      this.dealRepo.addEvent(deal.id, `Broker swap failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Submit a broker revert transaction.
   * This is an atomic operation that handles refund + commission.
   */
  private async submitBrokerRevert(item: QueueItem, deal: Deal): Promise<void> {
    console.log(`[BrokerRevert] Submitting broker revert for deal ${deal.id.slice(0, 8)}...`);

    if (!item.payback || !item.feeRecipient || !item.fees) {
      throw new Error(`Missing broker revert parameters in queue item ${item.id}`);
    }

    const plugin = this.pluginManager.getPlugin(item.chainId);

    if (!(plugin as any).revertViaBroker) {
      throw new Error(`Chain ${item.chainId} does not support broker reverts`);
    }

    // Get the full escrow account ref with keyRef
    let escrowRef = item.from;
    if (deal.escrowA && deal.escrowA.address === item.from.address) {
      escrowRef = deal.escrowA;
    } else if (deal.escrowB && deal.escrowB.address === item.from.address) {
      escrowRef = deal.escrowB;
    }

    // Determine if this is ERC20 or native
    const assetConfig = parseAssetCode(item.asset, item.chainId);
    const currency = assetConfig?.contractAddress; // undefined for native
    const decimals = assetConfig?.decimals; // Token decimals

    try {
      const result = await (plugin as any).revertViaBroker({
        dealId: item.dealId,
        escrow: escrowRef,
        payback: item.payback,
        feeRecipient: item.feeRecipient,
        fees: item.fees,
        currency: currency,
        decimals: decimals,
      });

      // Update queue item status (reuse plugin variable from beginning of method)
      const txRef: any = {
        txid: result.txid,
        chainId: item.chainId,
        requiredConfirms: plugin.getConfirmationThreshold(),
        submittedAt: result.submittedAt,
        confirms: 0,
        status: 'SUBMITTED',
        nonceOrInputs: result.nonceOrInputs,
        gasPrice: result.gasPrice,
      };

      this.queueRepo.updateStatus(item.id, 'SUBMITTED', txRef);
      this.dealRepo.addEvent(deal.id, `Broker revert submitted: ${result.txid.slice(0, 10)}...`);

      console.log(`[BrokerRevert] Transaction submitted successfully: ${result.txid}`);
    } catch (error: any) {
      console.error(`[BrokerRevert] Failed to submit broker revert:`, error.message);
      this.dealRepo.addEvent(deal.id, `Broker revert failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Submit a broker refund transaction (post-deal cleanup).
   * This is used for cleaning up late deposits after deal closure.
   */
  private async submitBrokerRefund(item: QueueItem, deal: Deal): Promise<void> {
    console.log(`[BrokerRefund] Submitting broker refund for deal ${deal.id.slice(0, 8)}...`);

    if (!item.payback || !item.feeRecipient || !item.fees) {
      throw new Error(`Missing broker refund parameters in queue item ${item.id}`);
    }

    const plugin = this.pluginManager.getPlugin(item.chainId);

    if (!(plugin as any).refundViaBroker) {
      throw new Error(`Chain ${item.chainId} does not support broker refunds`);
    }

    // Get the full escrow account ref with keyRef
    let escrowRef = item.from;
    if (deal.escrowA && deal.escrowA.address === item.from.address) {
      escrowRef = deal.escrowA;
    } else if (deal.escrowB && deal.escrowB.address === item.from.address) {
      escrowRef = deal.escrowB;
    }

    // Determine if this is ERC20 or native
    const assetConfig = parseAssetCode(item.asset, item.chainId);
    const currency = assetConfig?.contractAddress; // undefined for native
    const decimals = assetConfig?.decimals; // Token decimals

    try {
      const result = await (plugin as any).refundViaBroker({
        dealId: item.dealId,
        escrow: escrowRef,
        payback: item.payback,
        feeRecipient: item.feeRecipient,
        fees: item.fees,
        currency: currency,
        decimals: decimals,
      });

      // Update queue item status (reuse plugin variable from beginning of method)
      const txRef: any = {
        txid: result.txid,
        chainId: item.chainId,
        requiredConfirms: plugin.getConfirmationThreshold(),
        submittedAt: result.submittedAt,
        confirms: 0,
        status: 'SUBMITTED',
        nonceOrInputs: result.nonceOrInputs,
        gasPrice: result.gasPrice,
      };

      this.queueRepo.updateStatus(item.id, 'SUBMITTED', txRef);
      this.dealRepo.addEvent(deal.id, `Broker post-deal refund submitted: ${result.txid.slice(0, 10)}...`);

      console.log(`[BrokerRefund] Transaction submitted successfully: ${result.txid}`);
    } catch (error: any) {
      console.error(`[BrokerRefund] Failed to submit broker refund:`, error.message);
      this.dealRepo.addEvent(deal.id, `Broker refund failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check for late deposits to closed/reverted deals.
   * Creates broker refund queue items for any leftover funds.
   */
  private async checkForLateDeposits(deal: Deal): Promise<void> {
    // Only check deals in CLOSED or REVERTED state
    if (deal.stage !== 'CLOSED' && deal.stage !== 'REVERTED') {
      return;
    }

    // Skip if deal was closed/reverted very recently (within 5 minutes)
    // This avoids false positives from pending transactions
    const closedRecently = deal.events
      .filter(e => e.msg.includes('CLOSED') || e.msg.includes('REVERTED'))
      .some(e => new Date(e.t).getTime() > Date.now() - 5 * 60 * 1000);

    if (closedRecently) {
      return;
    }

    // Check both sides for late deposits
    const sides = [
      { party: 'ALICE' as const, escrow: deal.escrowA, spec: deal.alice, details: deal.aliceDetails },
      { party: 'BOB' as const, escrow: deal.escrowB, spec: deal.bob, details: deal.bobDetails }
    ];

    for (const side of sides) {
      if (!side.escrow || !side.details) {
        continue;
      }

      try {
        const plugin = this.pluginManager.getPlugin(side.spec.chainId);

        // Query current balance
        const depositsView = await plugin.listConfirmedDeposits(
          side.spec.asset,
          side.escrow.address,
          0, // No confirmation requirement for balance check
          undefined
        );

        const balance = depositsView.totalConfirmed;

        // If balance > 0, there are leftover funds
        if (parseFloat(balance) > 0) {
          console.log(`[LateDeposit] Found ${balance} ${side.spec.asset} in ${side.party} escrow for closed deal ${deal.id.slice(0, 8)}...`);

          // Check if we already have a pending BROKER_REFUND for this escrow
          const existingRefunds = this.queueRepo.getByDeal(deal.id)
            .filter(q =>
              q.purpose === 'BROKER_REFUND' &&
              q.from.address === side.escrow!.address &&
              q.status !== 'COMPLETED'
            );

          if (existingRefunds.length > 0) {
            console.log(`[LateDeposit] Refund already queued for ${side.party} escrow, skipping`);
            continue;
          }

          await this.createBrokerRefund(deal, side.party, side.spec, side.escrow, side.details.paybackAddress, balance);
        }
      } catch (error: any) {
        console.error(`[LateDeposit] Error checking ${side.party} escrow:`, error.message);
      }
    }
  }

  /**
   * Create broker refund queue item for late deposit.
   */
  private async createBrokerRefund(
    deal: Deal,
    party: 'ALICE' | 'BOB',
    spec: any,
    escrow: EscrowAccountRef,
    paybackAddress: string,
    amount: string
  ): Promise<void> {
    const plugin = this.pluginManager.getPlugin(spec.chainId);

    // Check if broker available
    if (!(plugin as any).refundViaBroker) {
      console.warn(`[LateDeposit] Cannot create broker refund for ${spec.chainId} - broker not available`);
      return;
    }

    // Estimate gas/commission fee for refund operation
    // For simplicity, use a fixed small fee (operator will charge minimal fee for cleanup)
    const feeAmount = '0.001'; // Small fixed fee

    // Generate unique tracking ID for this late deposit refund
    const refundTrackingId = `${deal.id}_late_${party}_${Date.now()}`;

    console.log(`[LateDeposit] Creating BROKER_REFUND queue item for deal ${deal.id}, party ${party}, amount ${amount}`);

    // Create queue item
    const queueItem = {
      id: crypto.randomBytes(16).toString('hex'),
      dealId: refundTrackingId, // Use tracking ID instead of original deal ID
      chainId: spec.chainId,
      from: escrow,
      to: paybackAddress, // Not used for broker refund, but kept for consistency
      asset: spec.asset,
      amount: amount,
      purpose: 'BROKER_REFUND' as const,
      phase: 'PHASE_3_REFUND' as const,
      seq: 0, // Not used for broker operations
      status: 'PENDING' as const,
      createdAt: new Date().toISOString(),
      payback: paybackAddress,
      feeRecipient: plugin.getOperatorAddress(),
      fees: feeAmount,
    };

    this.queueRepo.enqueue(queueItem);
    this.dealRepo.addEvent(deal.id, `Late deposit detected: ${amount} ${spec.asset} from ${party}, refund queued`);

    console.log(`[LateDeposit] BROKER_REFUND queued for deal ${deal.id}, party ${party}`);
  }

  /**
   * Get actual current balance for an escrow address
   * For UTXO chains: sum of available UTXOs
   * For account chains: current balance
   */
  private async getActualBalance(
    plugin: any,
    chainId: string,
    escrowAddress: string,
    asset: string
  ): Promise<string> {
    try {
      if (chainId === 'UNICITY') {
        // For Unicity, get actual UTXOs and calculate balance
        const scriptHash = (plugin as any).addressToScriptHash(escrowAddress);
        const utxos = await (plugin as any).electrumRequest('blockchain.scripthash.listunspent', [scriptHash]);
        
        if (!utxos || utxos.length === 0) {
          return '0';
        }
        
        // Sum up UTXO values (in satoshis)
        const totalSatoshis = utxos.reduce((sum: number, utxo: any) => sum + utxo.value, 0);
        const totalAlpha = (totalSatoshis / 100000000).toString();
        
        console.log(`[Engine] Unicity escrow ${escrowAddress} has ${utxos.length} UTXOs, total: ${totalAlpha} ALPHA`);
        return totalAlpha;
      } else if (chainId === 'POLYGON' || chainId === 'ETH') {
        // For EVM chains, check balance via web3
        try {
          // Check if it's a native asset or token
          const nativeAsset = chainId === 'POLYGON' ? 'MATIC' : 'ETH';
          
          if (asset === nativeAsset || asset === `${nativeAsset}@${chainId}`) {
            // Get native balance
            const provider = (plugin as any).provider;
            if (provider) {
              const balance = await provider.getBalance(escrowAddress);
              const ethBalance = (Number(balance) / 1e18).toString();
              console.log(`[Engine] ${chainId} escrow ${escrowAddress} has ${ethBalance} ${nativeAsset}`);
              return ethBalance;
            }
          } else if (asset.startsWith('ERC20:')) {
            // Get ERC20 token balance
            const tokenAddress = asset.split(':')[1].split('@')[0];
            const provider = (plugin as any).provider;
            if (provider) {
              // Create contract instance to check balance
              const abi = ['function balanceOf(address) view returns (uint256)'];
              const { Contract } = await import('ethers');
              const contract = new Contract(tokenAddress, abi, provider);
              const balance = await contract.balanceOf(escrowAddress);
              
              // Assume 6 decimals for USDT/USDC (common stablecoins)
              // This should ideally check the token's decimals
              const decimals = 6; // TODO: Get actual decimals from contract
              const tokenBalance = (Number(balance) / Math.pow(10, decimals)).toString();
              console.log(`[Engine] ${chainId} escrow ${escrowAddress} has ${tokenBalance} of token ${tokenAddress}`);
              return tokenBalance;
            }
          }
        } catch (error) {
          console.error(`[Engine] Error getting EVM balance:`, error);
        }
        return '0';
      } else {
        console.log(`[Engine] Balance check not implemented for ${chainId}, skipping`);
        return '0';
      }
    } catch (error) {
      console.error(`[Engine] Error getting balance for ${escrowAddress}:`, error);
      return '0';
    }
  }

  private async monitorAndReturnEscrowFunds(deal: Deal) {
    // Monitor and return any remaining funds in escrows for up to 7 days
    // This handles both REVERTED deals and post-close deposits

    // Skip if deal isn't in a terminal state
    if (!['CLOSED', 'REVERTED'].includes(deal.stage)) {
      return;
    }

    // Check if deal has been closed/reverted for more than 7 days
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const dealCreatedAt = new Date(deal.createdAt).getTime();
    const now = Date.now();
    const dealAge = now - dealCreatedAt;

    if (dealAge > SEVEN_DAYS_MS) {
      console.log(`[Engine] Skipping escrow monitoring for deal ${deal.id} - older than 7 days (${Math.floor(dealAge / (24 * 60 * 60 * 1000))} days old)`);
      return;
    }

    console.log(`[Engine] Monitoring escrows for ${deal.stage} deal ${deal.id} (age: ${Math.floor(dealAge / (24 * 60 * 60 * 1000))} days)`);
    
    try {
      // Check if escrows were gas-funded by tank
      const aliceEscrowGasFunded = await this.wasEscrowGasFunded(deal.id, deal.alice.chainId, deal.escrowA);
      const bobEscrowGasFunded = await this.wasEscrowGasFunded(deal.id, deal.bob.chainId, deal.escrowB);
      
      // Check Alice's escrow for any balances
      if (deal.escrowA && deal.aliceDetails) {
        console.log(`[Engine] Checking Alice's escrow ${deal.escrowA.address} on ${deal.alice.chainId}`);
        const plugin = this.pluginManager.getPlugin(deal.alice.chainId);
        const escrowAddress = await plugin.getManagedAddress(deal.escrowA);
      
        // Check for ANY asset balance (not just the deal asset)
        // First check the primary asset
        const aliceAsset = deal.alice.asset;
        
        console.log(`[Engine] Getting balance for ${aliceAsset} at ${escrowAddress}`);
        
        // Get the ACTUAL current balance (what's really there now)
        const currentBalance = await this.getActualBalance(
          plugin,
          deal.alice.chainId,
          escrowAddress,
          aliceAsset
        );
        
        console.log(`[Engine] Balance check result: ${currentBalance} ${aliceAsset}`);
      
      const remainingBalance = parseFloat(currentBalance);
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

        if (alreadyQueued) {
          // There's already a PENDING/SUBMITTED queue item
          console.log(`[ESCROW MONITOR] Found existing queue item for ${aliceAsset}`);

          // Check if any of these items are STUCK (submitted > 10 minutes with 0 confirms)
          const now = Date.now();
          const STUCK_THRESHOLD = 10 * 60 * 1000; // 10 minutes

          for (const existingItem of existingQueues) {
            if (existingItem.status === 'SUBMITTED' && existingItem.submittedTx) {
              const submittedAt = new Date(existingItem.submittedTx.submittedAt).getTime();
              const age = now - submittedAt;

              if (age > STUCK_THRESHOLD && existingItem.submittedTx.confirms === 0) {
                console.warn(`[ESCROW MONITOR] Found STUCK transaction ${existingItem.id}:`);
                console.warn(`  TX: ${existingItem.submittedTx.txid}`);
                console.warn(`  Age: ${Math.floor(age / 60000)} minutes`);
                console.warn(`  Confirms: 0`);
                console.warn(`  Nonce: ${existingItem.submittedTx.nonceOrInputs}`);

                // Mark as COMPLETED so a new one can be created
                this.queueRepo.updateStatus(existingItem.id, 'COMPLETED');
                this.dealRepo.addEvent(deal.id, `Marked stuck ${existingItem.purpose} transaction as COMPLETED (nonce ${existingItem.submittedTx.nonceOrInputs}, age: ${Math.floor(age / 60000)}min)`);

                console.log(`[ESCROW MONITOR] Marked ${existingItem.id} as COMPLETED - will create new refund`);

                // Exit the alreadyQueued block to create a new queue item
                // by falling through to the else block logic
                const funded = await this.ensureGasForRefund(
                  escrowAddress,
                  deal.alice.chainId,
                  deal.id,
                  aliceAsset
                );

                if (!funded) {
                  console.log(`[ESCROW MONITOR] Proceeding with refund despite gas funding issue for ${aliceAsset}`);
                }

                this.queueRepo.enqueue({
                  dealId: deal.id,
                  chainId: deal.alice.chainId,
                  from: deal.escrowA,
                  to: deal.aliceDetails.paybackAddress,
                  asset: aliceAsset,
                  amount: currentBalance,
                  purpose: 'TIMEOUT_REFUND',
                });
                this.dealRepo.addEvent(deal.id, `Creating new refund for ${currentBalance} ${aliceAsset} after stuck transaction`);

                return; // Exit early after creating new item
              }
            }
          }

          // If we reach here, existing items are not stuck - just ensure gas
          console.log(`[ESCROW MONITOR] Existing queue items not stuck - checking gas`);
          await this.ensureGasForRefund(
            escrowAddress,
            deal.alice.chainId,
            deal.id,
            aliceAsset
          );
        } else {
          console.log(`[ESCROW MONITOR] Found ${remainingBalance} ${aliceAsset} in Alice's escrow ${escrowAddress}`);

          // Ensure gas for ERC-20 refund if needed
          const funded = await this.ensureGasForRefund(
            escrowAddress,
            deal.alice.chainId,
            deal.id,
            aliceAsset
          );

          if (!funded) {
            console.log(`[ESCROW MONITOR] Proceeding with refund despite gas funding issue for ${aliceAsset}`);
          }

          this.queueRepo.enqueue({
            dealId: deal.id,
            chainId: deal.alice.chainId,
            from: deal.escrowA,
            to: deal.aliceDetails.paybackAddress,
            asset: aliceAsset,
            amount: currentBalance, // Use the actual current balance
            purpose: 'TIMEOUT_REFUND', // Use TIMEOUT_REFUND for post-deal returns
          });
          this.dealRepo.addEvent(deal.id, `Auto-returning ${currentBalance} ${aliceAsset} from Alice's escrow`);
        }
      }
      
      // Also check for native currency if the deal asset wasn't native
      const nativeAsset = getNativeAsset(deal.alice.chainId);
      if (aliceAsset !== nativeAsset) {
        // CRITICAL: If deal asset is not native (ERC-20/SPL), ALL native currency MUST go to tank
        // because parties never send native currency in token deals - it only comes from tank for gas
        // Get the ACTUAL current native balance
        const currentNativeBalance = await this.getActualBalance(
          plugin,
          deal.alice.chainId,
          escrowAddress,
          nativeAsset
        );

        const nativeBalance = parseFloat(currentNativeBalance);
        if (nativeBalance > 0.000001) {
          const existingNativeQueues = this.queueRepo.getByDeal(deal.id)
            .filter(q => q.from.address === escrowAddress &&
                        q.asset === nativeAsset &&
                        (q.status === 'PENDING' || q.status === 'SUBMITTED'));

          // Check if any existing native currency items are STUCK
          const now = Date.now();
          const STUCK_THRESHOLD = 10 * 60 * 1000; // 10 minutes

          for (const existingItem of existingNativeQueues) {
            if (existingItem.status === 'SUBMITTED' && existingItem.submittedTx) {
              const submittedAt = new Date(existingItem.submittedTx.submittedAt).getTime();
              const age = now - submittedAt;

              if (age > STUCK_THRESHOLD && existingItem.submittedTx.confirms === 0) {
                console.warn(`[ESCROW MONITOR] Found STUCK native currency transaction ${existingItem.id}:`);
                console.warn(`  TX: ${existingItem.submittedTx.txid}`);
                console.warn(`  Age: ${Math.floor(age / 60000)} minutes`);
                console.warn(`  Asset: ${nativeAsset}, Amount: ${existingItem.amount}`);
                console.warn(`  Nonce: ${existingItem.submittedTx.nonceOrInputs}`);

                // Mark as COMPLETED so a new one can be created
                this.queueRepo.updateStatus(existingItem.id, 'COMPLETED');
                this.dealRepo.addEvent(deal.id, `Marked stuck Alice's ${nativeAsset} gas refund as COMPLETED (nonce ${existingItem.submittedTx.nonceOrInputs})`);

                console.log(`[ESCROW MONITOR] Stuck native currency transaction marked COMPLETED - will create fresh refund`);

                // Create new gas refund with fresh nonce
                // CRITICAL: For non-native assets (ERC-20/SPL), ALL native currency goes to tank
                const returnAddress = this.getTankAddress() || deal.aliceDetails.paybackAddress;
                const purpose = 'GAS_REFUND_TO_TANK';

                this.queueRepo.enqueue({
                  dealId: deal.id,
                  chainId: deal.alice.chainId,
                  from: deal.escrowA,
                  to: returnAddress,
                  asset: nativeAsset,
                  amount: currentNativeBalance,
                  purpose: purpose,
                });
                this.dealRepo.addEvent(deal.id, `Created fresh ${currentNativeBalance} ${nativeAsset} gas refund after unstucking`);

                return; // Exit early after creating new item
              }
            }
          }

          const alreadyQueued = existingNativeQueues.some(q =>
            Math.abs(parseFloat(q.amount) - nativeBalance) < 0.01
          );

          if (!alreadyQueued) {
            // CRITICAL: For non-native assets (ERC-20/SPL), ALL native currency goes to tank
            // because parties never send native currency in token deals - it only comes from tank for gas
            const returnAddress = this.getTankAddress() || deal.aliceDetails.paybackAddress;
            const purpose = 'GAS_REFUND_TO_TANK';

            console.log(`[ESCROW MONITOR] Found ${nativeBalance} ${nativeAsset} (native) in Alice's escrow ${escrowAddress}`);
            console.log(`[ESCROW MONITOR] Returning to tank wallet (${returnAddress})`);
            
            this.queueRepo.enqueue({
              dealId: deal.id,
              chainId: deal.alice.chainId,
              from: deal.escrowA,
              to: returnAddress,
              asset: nativeAsset,
              amount: currentNativeBalance, // Use actual current balance
              purpose: purpose,
            });
            this.dealRepo.addEvent(deal.id, `Auto-returning ${currentNativeBalance} ${nativeAsset} gas from Alice's escrow to tank wallet`);
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
      
      // Get the ACTUAL current balance (what's really there now)
      const currentBalance = await this.getActualBalance(
        plugin,
        deal.bob.chainId,
        escrowAddress,
        bobAsset
      );
      
      const remainingBalance = parseFloat(currentBalance);
      if (remainingBalance > 0.000001) { // Small threshold to avoid dust
        // Check if we already have a pending or submitted return for this escrow
        const existingQueues = this.queueRepo.getByDeal(deal.id)
          .filter(q => q.from.address === escrowAddress &&
                      q.asset === bobAsset &&
                      (q.status === 'PENDING' || q.status === 'SUBMITTED') &&
                      Math.abs(parseFloat(q.amount) - remainingBalance) < 0.01);

        if (existingQueues.length > 0) {
          // There's already a PENDING/SUBMITTED queue item, but we need to check if it's stuck
          console.log(`[ESCROW MONITOR] Found existing queue item for ${bobAsset} - checking if stuck`);

          // Check if any of these items are STUCK (submitted > 10 minutes with 0 confirms)
          const now = Date.now();
          const STUCK_THRESHOLD = 10 * 60 * 1000; // 10 minutes

          for (const existingItem of existingQueues) {
            if (existingItem.status === 'SUBMITTED' && existingItem.submittedTx) {
              const submittedAt = new Date(existingItem.submittedTx.submittedAt).getTime();
              const age = now - submittedAt;

              if (age > STUCK_THRESHOLD && existingItem.submittedTx.confirms === 0) {
                console.warn(`[ESCROW MONITOR] Found STUCK transaction ${existingItem.id}:`);
                console.warn(`  TX: ${existingItem.submittedTx.txid}`);
                console.warn(`  Age: ${Math.floor(age / 60000)} minutes`);
                console.warn(`  Asset: ${bobAsset}, Amount: ${existingItem.amount}`);
                console.warn(`  Nonce: ${existingItem.submittedTx.nonceOrInputs}`);

                // Mark as COMPLETED so a new one can be created
                this.queueRepo.updateStatus(existingItem.id, 'COMPLETED');
                this.dealRepo.addEvent(deal.id, `Marked stuck Bob's ${bobAsset} refund as COMPLETED (nonce ${existingItem.submittedTx.nonceOrInputs})`);

                console.log(`[ESCROW MONITOR] Stuck transaction marked COMPLETED - will create fresh refund`);

                // Ensure gas for ERC-20 refund if needed
                const funded = await this.ensureGasForRefund(
                  escrowAddress,
                  deal.bob.chainId,
                  deal.id,
                  bobAsset
                );

                if (!funded) {
                  console.log(`[ESCROW MONITOR] Proceeding with refund despite gas funding issue for ${bobAsset}`);
                }

                // Create new refund with fresh nonce
                this.queueRepo.enqueue({
                  dealId: deal.id,
                  chainId: deal.bob.chainId,
                  from: deal.escrowB,
                  to: deal.bobDetails.paybackAddress,
                  asset: bobAsset,
                  amount: currentBalance,
                  purpose: 'TIMEOUT_REFUND',
                });
                this.dealRepo.addEvent(deal.id, `Created fresh ${currentBalance} ${bobAsset} refund to Bob's payback address after unstucking`);

                return; // Exit early after creating new item
              }
            }
          }

          // Not stuck - just ensure it has gas
          console.log(`[ESCROW MONITOR] Existing queue item not stuck - checking gas`);
          await this.ensureGasForRefund(
            escrowAddress,
            deal.bob.chainId,
            deal.id,
            bobAsset
          );
        } else {
          console.log(`[ESCROW MONITOR] Found ${remainingBalance} ${bobAsset} in Bob's escrow ${escrowAddress}`);
          console.log(`[ESCROW MONITOR] Bob's payback address: ${deal.bobDetails.paybackAddress}`);
          console.log(`[ESCROW MONITOR] Bob's recipient address: ${deal.bobDetails.recipientAddress}`);

          // CRITICAL: Use payback address for refunds, NOT the source address
          if (!deal.bobDetails.paybackAddress) {
            console.error(`[CRITICAL] No payback address for Bob in deal ${deal.id}!`);
            return;
          }

          // Ensure gas for ERC-20 refund if needed
          const funded = await this.ensureGasForRefund(
            escrowAddress,
            deal.bob.chainId,
            deal.id,
            bobAsset
          );

          if (!funded) {
            console.log(`[ESCROW MONITOR] Proceeding with refund despite gas funding issue for ${bobAsset}`);
          }

          this.queueRepo.enqueue({
            dealId: deal.id,
            chainId: deal.bob.chainId,
            from: deal.escrowB,
            to: deal.bobDetails.paybackAddress, // MUST use payback address
            asset: bobAsset,
            amount: currentBalance,
            purpose: 'TIMEOUT_REFUND', // Use TIMEOUT_REFUND for post-deal returns
          });
          this.dealRepo.addEvent(deal.id, `Auto-returning ${currentBalance} ${bobAsset} to Bob's payback address: ${deal.bobDetails.paybackAddress}`);
        }
      }
      
      // Also check for native currency if the deal asset wasn't native
      const nativeAsset = getNativeAsset(deal.bob.chainId);
      if (bobAsset !== nativeAsset) {
        // CRITICAL: If deal asset is not native (ERC-20/SPL), ALL native currency MUST go to tank
        // because parties never send native currency in token deals - it only comes from tank for gas
        // Get the ACTUAL current native balance
        const currentNativeBalance = await this.getActualBalance(
          plugin,
          deal.bob.chainId,
          escrowAddress,
          nativeAsset
        );

        const nativeBalance = parseFloat(currentNativeBalance);
        if (nativeBalance > 0.000001) {
          const existingNativeQueues = this.queueRepo.getByDeal(deal.id)
            .filter(q => q.from.address === escrowAddress &&
                        q.asset === nativeAsset &&
                        (q.status === 'PENDING' || q.status === 'SUBMITTED'));

          // Check if any existing native currency items are STUCK
          const now = Date.now();
          const STUCK_THRESHOLD = 10 * 60 * 1000; // 10 minutes

          for (const existingItem of existingNativeQueues) {
            if (existingItem.status === 'SUBMITTED' && existingItem.submittedTx) {
              const submittedAt = new Date(existingItem.submittedTx.submittedAt).getTime();
              const age = now - submittedAt;

              if (age > STUCK_THRESHOLD && existingItem.submittedTx.confirms === 0) {
                console.warn(`[ESCROW MONITOR] Found STUCK native currency transaction ${existingItem.id}:`);
                console.warn(`  TX: ${existingItem.submittedTx.txid}`);
                console.warn(`  Age: ${Math.floor(age / 60000)} minutes`);
                console.warn(`  Asset: ${nativeAsset}, Amount: ${existingItem.amount}`);
                console.warn(`  Nonce: ${existingItem.submittedTx.nonceOrInputs}`);

                // Mark as COMPLETED so a new one can be created
                this.queueRepo.updateStatus(existingItem.id, 'COMPLETED');
                this.dealRepo.addEvent(deal.id, `Marked stuck Bob's ${nativeAsset} gas refund as COMPLETED (nonce ${existingItem.submittedTx.nonceOrInputs})`);

                console.log(`[ESCROW MONITOR] Stuck native currency transaction marked COMPLETED - will create fresh refund`);

                // Create new gas refund with fresh nonce
                // CRITICAL: For non-native assets (ERC-20/SPL), ALL native currency goes to tank
                const returnAddress = this.getTankAddress() || deal.bobDetails.paybackAddress;
                const purpose = 'GAS_REFUND_TO_TANK';

                this.queueRepo.enqueue({
                  dealId: deal.id,
                  chainId: deal.bob.chainId,
                  from: deal.escrowB,
                  to: returnAddress,
                  asset: nativeAsset,
                  amount: currentNativeBalance,
                  purpose: purpose,
                });
                this.dealRepo.addEvent(deal.id, `Created fresh ${currentNativeBalance} ${nativeAsset} gas refund after unstucking`);

                return; // Exit early after creating new item
              }
            }
          }

          const alreadyQueued = existingNativeQueues.some(q =>
            Math.abs(parseFloat(q.amount) - nativeBalance) < 0.01
          );

          if (!alreadyQueued) {
            // CRITICAL: For non-native assets (ERC-20/SPL), ALL native currency goes to tank
            // because parties never send native currency in token deals - it only comes from tank for gas
            const returnAddress = this.getTankAddress() || deal.bobDetails.paybackAddress;
            const purpose = 'GAS_REFUND_TO_TANK';

            console.log(`[ESCROW MONITOR] Found ${nativeBalance} ${nativeAsset} (native) in Bob's escrow ${escrowAddress}`);
            console.log(`[ESCROW MONITOR] Returning to tank wallet (${returnAddress})`);
            
            this.queueRepo.enqueue({
              dealId: deal.id,
              chainId: deal.bob.chainId,
              from: deal.escrowB,
              to: returnAddress,
              asset: nativeAsset,
              amount: currentNativeBalance,
              purpose: purpose,
            });
            this.dealRepo.addEvent(deal.id, `Auto-returning ${currentNativeBalance} ${nativeAsset} gas from Bob's escrow to tank wallet`);
          }
        }
      }
    }
    
    // Process any pending queue items for this closed deal
    await this.processQueues(deal);
    } catch (error) {
      console.error(`[Engine] Error in monitorAndReturnEscrowFunds for deal ${deal.id}:`, error);
    }
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

        // CRITICAL: Capture gas information from first confirmed SWAP transaction
        if (item.purpose === 'SWAP_PAYOUT' && confirmations >= 1 && confirmations < txRef.requiredConfirms) {
          await this.captureGasAndCalculateReimbursement(item, plugin);
        }

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

  /**
   * Start independent queue processor that runs every intervalMs
   * This ensures queues are processed even when main engine loop is busy
   */
  private startQueueProcessor(intervalMs: number = 5000) {
    console.log(`[Engine] Starting independent queue processor with ${intervalMs}ms interval`);
    
    // Process queues immediately on start
    this.processAllQueues();
    
    // Set up interval for regular queue processing
    this.queueProcessingInterval = setInterval(async () => {
      // Skip if already processing to prevent concurrent execution
      if (this.isProcessingQueues) {
        console.log('[QueueProcessor] Skipping - queue processing already in progress');
        return;
      }
      
      await this.processAllQueues();
    }, intervalMs);
  }

  /**
   * Capture gas information from first confirmed SWAP transaction
   * and calculate reimbursement amount
   */
  private async captureGasAndCalculateReimbursement(
    item: any,
    plugin: ChainPlugin
  ): Promise<void> {
    try {
      // Skip if not an EVM chain
      const evmChains = ['ETH', 'POLYGON', 'BASE'];
      if (!evmChains.includes(item.chainId)) {
        return;
      }

      // Get the deal
      const deal = this.dealRepo.getById(item.dealId);
      if (!deal) return;

      // Skip if gas reimbursement already calculated
      if (deal.gasReimbursement?.status === 'CALCULATED' ||
          deal.gasReimbursement?.status === 'QUEUED' ||
          deal.gasReimbursement?.status === 'COMPLETED') {
        return;
      }

      // Skip if not enabled
      if (!deal.gasReimbursement?.enabled) {
        return;
      }

      console.log(`[GasReimbursement] Capturing gas information from SWAP tx ${item.submittedTx?.txid}`);

      // Get transaction receipt to extract gas information
      const provider = (plugin as any).provider;
      if (!provider) {
        console.error('[GasReimbursement] Provider not available on plugin');
        return;
      }

      const receipt = await provider.getTransactionReceipt(item.submittedTx!.txid);
      if (!receipt) {
        console.log('[GasReimbursement] Receipt not yet available');
        return;
      }

      // Extract gas information
      const gasUsed = receipt.gasUsed.toString();
      const gasPrice = receipt.gasPrice ? receipt.gasPrice.toString() : receipt.effectiveGasPrice.toString();

      console.log(`[GasReimbursement] Gas captured: gasUsed=${gasUsed}, gasPrice=${gasPrice}`);

      // Update the TxRef with gas information
      if (item.submittedTx) {
        item.submittedTx.gasUsed = gasUsed;
        item.submittedTx.gasPrice = gasPrice;
        this.queueRepo.updateStatus(item.id, 'SUBMITTED', item.submittedTx);
      }

      // Calculate reimbursement
      const result = await this.gasReimbursementCalculator.calculateReimbursement(
        deal,
        gasUsed,
        gasPrice,
        plugin
      );

      console.log(`[GasReimbursement] Calculation result:`, result);

      // Update deal with calculation
      if (result.shouldReimburse && result.calculation && result.token) {
        deal.gasReimbursement = {
          ...deal.gasReimbursement,
          enabled: true,
          token: result.token,
          chainId: result.chainId,
          escrowSide: result.escrowSide,
          calculation: result.calculation,
          status: 'CALCULATED'
        };

        this.dealRepo.update(deal);
        this.dealRepo.addEvent(deal.id, `Gas reimbursement calculated: ${result.calculation.tokenAmount} ${result.token}`);

        console.log(`[GasReimbursement] Updated deal with calculation`);
      } else if (!result.shouldReimburse) {
        deal.gasReimbursement = {
          ...deal.gasReimbursement,
          enabled: false,
          status: 'SKIPPED',
          skipReason: result.skipReason
        };

        this.dealRepo.update(deal);
        this.dealRepo.addEvent(deal.id, `Gas reimbursement skipped: ${result.skipReason}`);

        console.log(`[GasReimbursement] Skipped: ${result.skipReason}`);
      }
    } catch (error) {
      console.error('[GasReimbursement] Error capturing gas and calculating reimbursement:', error);
    }
  }

  /**
   * Process all pending queues across all deals with serial processing per address
   * This is called independently from the main engine loop
   */
  private async processAllQueues() {
    // Prevent concurrent processing
    if (this.isProcessingQueues) {
      console.log('[QueueProcessor] Already processing queues, skipping');
      return;
    }

    this.isProcessingQueues = true;

    try {
      // First, detect and handle stuck transactions
      await this.handleStuckTransactions();

      // Get all pending queue items across all deals
      const allPendingItems = this.queueRepo.getAll()
        .filter(q => q.status === 'PENDING')
        .sort((a, b) => a.seq - b.seq); // Process in order by sequence number

      if (allPendingItems.length === 0) {
        return;
      }

      console.log(`[QueueProcessor] Found ${allPendingItems.length} pending queue items`);

      // Group items by sender (chainId + fromAddr)
      const itemsBySender = new Map<string, typeof allPendingItems>();

      for (const item of allPendingItems) {
        const senderKey = `${item.chainId}:${item.from.address.toLowerCase()}`;
        if (!itemsBySender.has(senderKey)) {
          itemsBySender.set(senderKey, []);
        }
        itemsBySender.get(senderKey)!.push(item);
      }

      console.log(`[QueueProcessor] Processing transactions for ${itemsBySender.size} unique senders`);

      // Process each sender's transactions serially
      for (const [senderKey, items] of itemsBySender) {
        const [chainId, address] = senderKey.split(':');
        console.log(`[QueueProcessor] Processing ${items.length} transactions for ${chainId}:${address}`);

        // Process items for this sender one at a time (serial processing)
        for (const item of items) {
          try {
            // Get the deal for this item
            const deal = this.dealRepo.get(item.dealId);
            if (!deal) {
              console.error(`[QueueProcessor] Deal ${item.dealId} not found for queue item ${item.id}`);
              continue;
            }

            // Check if this is a phased item (Unicity)
            if (item.phase) {
              // For phased items, check if we can process this phase
              const canProcess = await this.canProcessPhase(deal, item);
              if (!canProcess) {
                console.log(`[QueueProcessor] Skipping phased item ${item.id} - phase not ready`);
                continue;
              }
            }

            // Process this single transaction
            await this.processSingleQueueItem(deal, item);

            // Wait a bit between transactions from same sender to ensure nonce ordering
            await new Promise(resolve => setTimeout(resolve, 100));

          } catch (error) {
            console.error(`[QueueProcessor] Error processing item ${item.id}:`, error);
            this.dealRepo.addEvent(item.dealId, `Queue processing error: ${error}`);
          }
        }
      }

    } catch (error) {
      console.error('[QueueProcessor] Unexpected error:', error);
    } finally {
      // Always release the lock
      this.isProcessingQueues = false;
    }
  }

  /**
   * Check if a phased item can be processed based on phase completion status
   */
  private async canProcessPhase(deal: Deal, item: any): Promise<boolean> {
    if (!item.phase) return true; // Non-phased items can always be processed

    // Check if previous phases are complete
    if (item.phase === 'PHASE_1_SWAP') {
      return true; // Phase 1 can always proceed
    } else if (item.phase === 'PHASE_2_COMMISSION') {
      // Phase 2 can only proceed if Phase 1 is complete
      return this.queueRepo.hasPhaseCompleted(deal.id, 'PHASE_1_SWAP');
    } else if (item.phase === 'PHASE_3_REFUND') {
      // Phase 3 can only proceed if Phase 1 and 2 are complete
      return this.queueRepo.hasPhaseCompleted(deal.id, 'PHASE_1_SWAP') &&
             (this.queueRepo.getPhaseItems(deal.id, 'PHASE_2_COMMISSION').length === 0 ||
              this.queueRepo.hasPhaseCompleted(deal.id, 'PHASE_2_COMMISSION'));
    }

    return false;
  }

  /**
   * Process a single queue item with proper nonce management for EVM chains
   */
  private async processSingleQueueItem(deal: Deal, item: any): Promise<void> {
    try {
      // CRITICAL SAFEGUARD: Block refunds if uncompleted swap payouts exist
      if (item.purpose === 'TIMEOUT_REFUND' && deal.stage !== 'CLOSED') {
        const swapPayouts = this.queueRepo.getByDeal(deal.id)
          .filter(q => q.purpose === 'SWAP_PAYOUT' && q.status !== 'COMPLETED');

        if (swapPayouts.length > 0) {
          console.error(`[CRITICAL] Blocking TIMEOUT_REFUND for deal ${deal.id} - uncompleted swap payouts exist!`);
          this.dealRepo.addEvent(deal.id, `CRITICAL: Blocked refund - ${swapPayouts.length} uncompleted swap payouts exist`);
          return;
        }
      }

      // Get the full escrow account ref with keyRef from the deal
      let fromAccountWithKey: any = item.from;
      if (deal.escrowA && deal.escrowA.address === item.from.address) {
        fromAccountWithKey = deal.escrowA;
      } else if (deal.escrowB && deal.escrowB.address === item.from.address) {
        fromAccountWithKey = deal.escrowB;
      }

      console.log(`[QueueProcessor] Submitting transaction:`, {
        id: item.id,
        chainId: item.chainId,
        from: item.from.address,
        to: item.to,
        asset: item.asset,
        amount: item.amount,
        purpose: item.purpose,
        phase: item.phase
      });

      // CRITICAL FIX: Handle BROKER_SWAP, BROKER_REVERT, and BROKER_REFUND separately (they don't use nonce logic)
      if (item.purpose === 'BROKER_SWAP') {
        console.log(`[QueueProcessor] Routing to submitBrokerSwap for item ${item.id}`);
        return this.submitBrokerSwap(item, deal);
      }

      if (item.purpose === 'BROKER_REVERT') {
        console.log(`[QueueProcessor] Routing to submitBrokerRevert for item ${item.id}`);
        return this.submitBrokerRevert(item, deal);
      }

      if (item.purpose === 'BROKER_REFUND') {
        console.log(`[QueueProcessor] Routing to submitBrokerRefund for item ${item.id}`);
        return this.submitBrokerRefund(item, deal);
      }

      const plugin = this.pluginManager.getPlugin(item.chainId);
      console.log(`[QueueProcessor] Using plugin for chain ${item.chainId}: ${plugin.constructor.name}`);

      // Prepare transaction options with nonce for EVM chains
      let txOptions: any = undefined;

      // Check if this is an EVM chain (has getCurrentNonce method)
      const isEvmChain = item.chainId === 'ETH' || item.chainId === 'POLYGON';
      if (isEvmChain && 'getCurrentNonce' in plugin) {
        // PRE-VALIDATION: Check queue integrity before reserving nonce
        const validation = this.queueRepo.validateNonceSequence(item.chainId, item.from.address);

        if (!validation.isValid) {
          console.warn(`[QueueProcessor] Queue integrity check FAILED for ${item.from.address}:`, validation);
          console.warn(`[QueueProcessor] Gaps: ${validation.gaps.join(', ')}, Duplicates: ${validation.duplicates.join(', ')}`);

          // Don't throw - log and skip this item, it will be retried next cycle
          this.dealRepo.addEvent(deal.id, `Queue integrity issue detected - gaps: ${validation.gaps.length}, duplicates: ${validation.duplicates.length}`);

          // Reset nonce tracking to recover
          this.accountRepo.resetNonce(item.chainId, item.from.address);
          console.log(`[QueueProcessor] Reset nonce tracking for ${item.from.address} - will retry next cycle`);

          return; // Skip this item for now
        }

        // ATOMIC nonce reservation with retry logic
        let nonce: number;
        let attempt = 0;
        const maxAttempts = 3;

        while (attempt < maxAttempts) {
          try {
            // Check if we need to fetch initial nonce from network
            const trackedNonce = this.accountRepo.getNextNonce(item.chainId, item.from.address);

            if (trackedNonce === null) {
              // First transaction for this address - fetch from network
              console.log(`[QueueProcessor] Fetching initial nonce from network for ${item.from.address}`);
              const networkNonce = await (plugin as any).getCurrentNonce(item.from.address);
              console.log(`[QueueProcessor] Got initial nonce from network: ${networkNonce}`);

              // Reserve nonce atomically with network nonce
              nonce = this.db.runInTransaction(() => {
                return this.accountRepo.reserveNextNonce(item.chainId, item.from.address, networkNonce);
              });
            } else {
              // Validate expected sequence: next nonce should be highest queued + 1
              const highestQueued = this.queueRepo.getHighestQueuedNonce(item.chainId, item.from.address);
              const expectedNonce = highestQueued !== null ? highestQueued + 1 : trackedNonce;

              console.log(`[QueueProcessor] Expected nonce: ${expectedNonce} (highest queued: ${highestQueued}, tracked: ${trackedNonce})`);

              // Reserve next nonce atomically
              nonce = this.db.runInTransaction(() => {
                return this.accountRepo.reserveNextNonce(item.chainId, item.from.address);
              });

              // VALIDATION: Verify we got the expected nonce
              if (nonce !== expectedNonce) {
                console.warn(`[QueueProcessor] Nonce mismatch! Expected ${expectedNonce}, got ${nonce}`);
                throw new Error(`Nonce sequence violation: expected ${expectedNonce}, got ${nonce}`);
              }
            }

            console.log(`[QueueProcessor] ✓ ATOMICALLY reserved nonce ${nonce} for ${item.from.address} (attempt ${attempt + 1})`);
            txOptions = { nonce };
            break; // Success!

          } catch (error: any) {
            attempt++;
            console.error(`[QueueProcessor] Nonce reservation attempt ${attempt} failed:`, error.message);

            if (attempt < maxAttempts) {
              // Exponential backoff: 100ms, 500ms, 2000ms
              const delay = Math.pow(5, attempt) * 100;
              console.log(`[QueueProcessor] Retrying in ${delay}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));

              // Reset nonce tracking before retry
              this.accountRepo.resetNonce(item.chainId, item.from.address);
            } else {
              // Max retries exceeded
              console.error(`[QueueProcessor] Max retry attempts exceeded for ${item.from.address}`);
              this.dealRepo.addEvent(deal.id, `Failed to reserve nonce after ${maxAttempts} attempts`);
              throw error; // Re-throw to trigger error handling
            }
          }
        }
      }

      // Submit the transaction with explicit nonce if EVM
      const tx = await plugin.send(
        item.asset,
        fromAccountWithKey,
        item.to,
        item.amount,
        txOptions
      );

      // SANITY CHECK: Verify nonce is not already used by another queue item
      if (isEvmChain && tx.nonceOrInputs) {
        const conflictingItem = this.queueRepo.findNonceConflict(
          item.chainId,
          item.from.address,
          tx.nonceOrInputs,
          item.id
        );

        if (conflictingItem) {
          const error = `CRITICAL: Nonce collision detected! Nonce ${tx.nonceOrInputs} already used by queue item ${conflictingItem.id} (${conflictingItem.purpose}, status: ${conflictingItem.status})`;
          console.error(`[QueueProcessor] ${error}`);
          console.error(`[QueueProcessor] Current item: ${item.id} (${item.purpose})`);
          console.error(`[QueueProcessor] Conflicting item: ${conflictingItem.id} (${conflictingItem.purpose})`);
          console.error(`[QueueProcessor] Account nonce state:`, this.accountRepo.getOrCreate(item.chainId, item.from.address));

          this.dealRepo.addEvent(deal.id, `COLLISION: Nonce ${tx.nonceOrInputs} conflict between ${item.purpose} and ${conflictingItem.purpose}`);

          // GRACEFUL RECOVERY: Don't throw, instead reset and retry next cycle
          console.log(`[QueueProcessor] Initiating collision recovery for ${item.from.address}...`);

          // Reset nonce tracking to re-sync with network
          this.accountRepo.resetNonce(item.chainId, item.from.address);

          // Log full queue state for debugging
          const queueValidation = this.queueRepo.validateNonceSequence(item.chainId, item.from.address);
          console.error(`[QueueProcessor] Queue state after collision:`, queueValidation);

          // Return without throwing - this will be retried in next engine cycle
          console.log(`[QueueProcessor] Skipping ${item.id} - will retry in next cycle after nonce reset`);
          return;
        }

        console.log(`[QueueProcessor] ✓ Nonce ${tx.nonceOrInputs} validation passed - no duplicates found`);

        // FINAL VALIDATION: Verify sequential ordering
        const highestQueued = this.queueRepo.getHighestQueuedNonce(item.chainId, item.from.address);
        const submittedNonce = parseInt(tx.nonceOrInputs);

        if (highestQueued !== null && submittedNonce !== highestQueued + 1) {
          console.warn(`[QueueProcessor] Nonce sequence warning: submitted nonce ${submittedNonce}, but highest queued is ${highestQueued}`);
          console.warn(`[QueueProcessor] Expected: ${highestQueued + 1}, Got: ${submittedNonce}`);

          // Log but don't block - this might be legitimate (e.g., first transaction for address)
          this.dealRepo.addEvent(deal.id, `Nonce sequence warning: gap between ${highestQueued} and ${submittedNonce}`);
        }

        console.log(`[QueueProcessor] ✓ Sequential ordering validated (highest queued: ${highestQueued}, new nonce: ${submittedNonce})`);
      }

      // Update queue item with tx info (reuse plugin variable from line 3186)
      const txRef: any = {
        txid: tx.txid,
        chainId: item.chainId,
        requiredConfirms: plugin.getConfirmationThreshold(),
        submittedAt: tx.submittedAt,
        confirms: 0,  // Initial confirms
        status: 'SUBMITTED',
        nonceOrInputs: tx.nonceOrInputs,  // Store nonce for EVM chains
        additionalTxids: tx.additionalTxids
      };

      this.queueRepo.updateStatus(item.id, 'SUBMITTED', txRef);

      // Store submission metadata for stuck detection
      this.queueRepo.updateSubmissionMetadata(item.id, {
        lastSubmitAt: new Date().toISOString(),
        originalNonce: txOptions?.nonce,
        lastGasPrice: (tx as any).gasPrice
      });

      this.dealRepo.addEvent(deal.id, `Submitted ${item.purpose} tx: ${tx.txid.slice(0, 10)}...`);

      console.log(`[QueueProcessor] Transaction submitted:`, {
        queueId: item.id,
        txid: tx.txid,
        nonce: txOptions?.nonce,
        gasPrice: (tx as any).gasPrice
      });

    } catch (error: any) {
      console.error(`[QueueProcessor] Failed to submit transaction for item ${item.id}:`, error);

      // Check if it's a nonce-related error
      if (error.message?.includes('nonce') || error.code === 'NONCE_EXPIRED') {
        console.log(`[QueueProcessor] Nonce error detected, resetting nonce tracking for ${item.from.address}`);
        this.accountRepo.resetNonce(item.chainId, item.from.address);
      }

      this.dealRepo.addEvent(deal.id, `Failed to submit ${item.purpose}: ${error.message}`);

      // Mark item as failed after too many attempts
      if (item.gasBumpAttempts && item.gasBumpAttempts >= 5) {
        // For now, mark as COMPLETED with error in event log
        this.queueRepo.updateStatus(item.id, 'COMPLETED');
      }

      throw error;
    }
  }

  /**
   * Detect and handle stuck transactions by bumping gas price
   */
  private async handleStuckTransactions(): Promise<void> {
    try {
      // Get all submitted transactions
      const submittedItems = this.queueRepo.getAll()
        .filter(q => q.status === 'SUBMITTED' && q.submittedTx);

      const now = Date.now();
      const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

      for (const item of submittedItems) {
        if (!item.submittedTx || !item.lastSubmitAt) continue;

        const submittedAt = new Date(item.lastSubmitAt).getTime();
        const timeSinceSubmission = now - submittedAt;

        // Check if transaction has been pending for too long
        if (timeSinceSubmission > STUCK_THRESHOLD_MS) {
          const plugin = this.pluginManager.getPlugin(item.chainId);

          // Check if transaction is still stuck
          const confirmations = await plugin.getTxConfirmations(item.submittedTx.txid);

          if (confirmations === 0) {
            // Check if it's actually stuck in mempool (for EVM chains)
            const isEvmChain = item.chainId === 'ETH' || item.chainId === 'POLYGON';

            if (isEvmChain && 'isTransactionStuck' in plugin) {
              const isStuck = await (plugin as any).isTransactionStuck(item.submittedTx.txid);

              if (isStuck) {
                console.log(`[QueueProcessor] Detected stuck transaction ${item.submittedTx.txid} for item ${item.id}`);
                await this.bumpGasAndResubmit(item);
              }
            }
          } else if (confirmations > 0) {
            // Transaction has confirmations, update nonce tracking
            if (item.originalNonce !== undefined) {
              this.accountRepo.updateLastConfirmedNonce(item.chainId, item.from.address, item.originalNonce);
            }
          }
        }
      }
    } catch (error) {
      console.error('[QueueProcessor] Error handling stuck transactions:', error);
    }
  }

  /**
   * Bump gas price and resubmit a stuck transaction
   */
  private async bumpGasAndResubmit(item: any): Promise<void> {
    try {
      const gasBumpAttempts = item.gasBumpAttempts || 0;

      if (gasBumpAttempts >= 5) {
        console.log(`[QueueProcessor] Max gas bump attempts reached for item ${item.id}`);
        return;
      }

      const deal = this.dealRepo.get(item.dealId);
      if (!deal) {
        console.error(`[QueueProcessor] Deal ${item.dealId} not found for gas bump`);
        return;
      }

      const plugin = this.pluginManager.getPlugin(item.chainId);

      // Get current gas price from network
      const currentGasPrice = await (plugin as any).getCurrentGasPrice();

      // Calculate new gas price (20% higher)
      let newGasPrice: any = {};
      if (currentGasPrice.gasPrice) {
        const oldPrice = parseFloat(item.lastGasPrice || currentGasPrice.gasPrice);
        const bumpedPrice = oldPrice * 1.2;
        newGasPrice.gasPrice = bumpedPrice.toFixed(2);
        console.log(`[QueueProcessor] Bumping gas price from ${oldPrice} to ${bumpedPrice} gwei`);
      } else if (currentGasPrice.maxFeePerGas) {
        // EIP-1559
        const oldMaxFee = parseFloat(item.lastGasPrice || currentGasPrice.maxFeePerGas);
        const bumpedMaxFee = oldMaxFee * 1.2;
        const bumpedPriority = parseFloat(currentGasPrice.maxPriorityFeePerGas!) * 1.2;
        newGasPrice.maxFeePerGas = bumpedMaxFee.toFixed(2);
        newGasPrice.maxPriorityFeePerGas = bumpedPriority.toFixed(2);
        console.log(`[QueueProcessor] Bumping EIP-1559 fees: maxFee ${bumpedMaxFee}, priority ${bumpedPriority} gwei`);
      }

      // Get the escrow account with key
      let fromAccountWithKey: any = item.from;
      if (deal.escrowA && deal.escrowA.address === item.from.address) {
        fromAccountWithKey = deal.escrowA;
      } else if (deal.escrowB && deal.escrowB.address === item.from.address) {
        fromAccountWithKey = deal.escrowB;
      }

      // Resubmit with same nonce but higher gas price
      const txOptions = {
        nonce: item.originalNonce,
        ...newGasPrice
      };

      console.log(`[QueueProcessor] Resubmitting transaction with gas bump:`, {
        queueId: item.id,
        originalTx: item.submittedTx.txid.slice(0, 10),
        nonce: txOptions.nonce,
        ...newGasPrice
      });

      const tx = await plugin.send(
        item.asset,
        fromAccountWithKey,
        item.to,
        item.amount,
        txOptions
      );

      // Update queue item with new tx info
      const txRef: any = {
        txid: tx.txid,
        chainId: item.chainId,
        requiredConfirms: plugin.getConfirmationThreshold(),
        submittedAt: tx.submittedAt,
        confirms: 0,  // Reset confirms for new submission
        status: 'SUBMITTED',
        additionalTxids: tx.additionalTxids
      };

      // Update with new transaction details
      this.queueRepo.updateStatus(item.id, 'SUBMITTED', txRef);

      // Update gas bump metadata
      this.queueRepo.updateSubmissionMetadata(item.id, {
        gasBumpAttempts: gasBumpAttempts + 1,
        lastSubmitAt: new Date().toISOString(),
        lastGasPrice: (tx as any).gasPrice
      });

      this.dealRepo.addEvent(item.dealId, `Gas bumped tx: ${tx.txid.slice(0, 10)}... (attempt ${gasBumpAttempts + 1})`);

    } catch (error) {
      console.error(`[QueueProcessor] Failed to bump gas for item ${item.id}:`, error);
      this.dealRepo.addEvent(item.dealId, `Failed to bump gas: ${error}`);
    }
  }
}