/**
 * @fileoverview Background worker for resolving synthetic transaction IDs.
 * Runs periodically to find and resolve synthetic deposits by querying blockchain events.
 */

import { DB } from '../db/database';
import { PluginManager } from '@otc-broker/chains';
import { TxidResolver } from '../services/TxidResolver';

/**
 * Background worker that periodically resolves synthetic transaction IDs.
 *
 * Features:
 * - Runs every 60 seconds
 * - Processes up to 10 deposits per cycle
 * - Implements exponential backoff on failures
 * - Logs resolution progress and statistics
 */
export class ResolutionWorker {
  private running = false;
  private intervalId?: NodeJS.Timeout;
  private resolver: TxidResolver;
  private readonly INTERVAL_MS = 60_000; // 60 seconds
  private readonly MAX_DEPOSITS_PER_CYCLE = 10;

  constructor(
    private db: DB,
    private pluginManager: PluginManager
  ) {
    this.resolver = new TxidResolver(db, pluginManager);
  }

  /**
   * Start the resolution worker
   */
  start(): void {
    if (this.running) {
      console.log('[ResolutionWorker] Already running');
      return;
    }

    console.log('[ResolutionWorker] Starting resolution worker');
    this.running = true;

    // Run immediately on start
    this.processCycle().catch(err => {
      console.error('[ResolutionWorker] Error in initial cycle:', err);
    });

    // Then run on interval
    this.intervalId = setInterval(() => {
      this.processCycle().catch(err => {
        console.error('[ResolutionWorker] Error in processing cycle:', err);
      });
    }, this.INTERVAL_MS);
  }

  /**
   * Stop the resolution worker
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    console.log('[ResolutionWorker] Stopping resolution worker');
    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  /**
   * Process one cycle of resolution attempts
   */
  private async processCycle(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      // Get statistics
      const stats = this.resolver.getResolutionStats();

      if (stats.pending > 0) {
        console.log('[ResolutionWorker] Resolution statistics:', {
          total: stats.total,
          resolved: stats.resolved,
          pending: stats.pending,
          failed: stats.failed
        });
      }

      // Find unresolved deposits
      const deposits = this.resolver.findUnresolvedDeposits();

      if (deposits.length === 0) {
        // No work to do
        return;
      }

      console.log(`[ResolutionWorker] Found ${deposits.length} unresolved synthetic deposits`);

      // Process up to MAX_DEPOSITS_PER_CYCLE deposits
      const depositsToProcess = deposits.slice(0, this.MAX_DEPOSITS_PER_CYCLE);

      let successCount = 0;
      let failureCount = 0;

      for (const deposit of depositsToProcess) {
        try {
          console.log(`[ResolutionWorker] Attempting to resolve deposit ${deposit.id} (attempt ${deposit.resolution_attempts + 1})`);

          const result = await this.resolver.resolveDeposit(deposit);

          if (result.success) {
            successCount++;
            console.log(`[ResolutionWorker] Successfully resolved ${deposit.txid} -> ${result.resolvedTxid} (confidence: ${result.confidence})`);
          } else {
            failureCount++;
            console.log(`[ResolutionWorker] Failed to resolve ${deposit.txid}: ${result.errorMessage}`);
          }

          // Add a small delay between resolutions to avoid overwhelming the RPC
          await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error) {
          failureCount++;
          console.error(`[ResolutionWorker] Unexpected error resolving deposit ${deposit.id}:`, error);
        }
      }

      if (successCount > 0 || failureCount > 0) {
        console.log(`[ResolutionWorker] Cycle complete: ${successCount} resolved, ${failureCount} failed`);
      }

    } catch (error) {
      console.error('[ResolutionWorker] Error in processing cycle:', error);
    }
  }

  /**
   * Get current worker status
   */
  getStatus(): {
    running: boolean;
    stats: ReturnType<TxidResolver['getResolutionStats']>;
  } {
    return {
      running: this.running,
      stats: this.resolver.getResolutionStats()
    };
  }

  /**
   * Manually trigger a resolution cycle (for testing/debugging)
   */
  async triggerCycle(): Promise<void> {
    console.log('[ResolutionWorker] Manually triggering resolution cycle');
    await this.processCycle();
  }
}
