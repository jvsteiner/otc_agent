/**
 * @fileoverview TxidResolver service for resolving synthetic transaction IDs.
 * Converts synthetic txids (like erc20-balance-0xc2132D05) to real transaction hashes
 * by querying blockchain Transfer events and matching by amount and address.
 */

import { DB } from '../db/database';
import { PluginManager } from '@otc-broker/chains';
import { ChainId, AssetCode } from '@otc-broker/core';
import Decimal from 'decimal.js';

/**
 * Transfer event from blockchain query
 */
export interface TransferEvent {
  txHash: string;
  blockNumber: number;
  blockTimestamp?: number;
  from: string;
  to: string;
  value: string; // Amount as string
  logIndex: number;
}

/**
 * Matched transaction with confidence score
 */
interface MatchedTransaction {
  txHash: string;
  blockNumber: number;
  blockTimestamp?: number;
  amount: string;
  confidence: number; // 0-1 score
  eventData: TransferEvent;
}

/**
 * Resolution result
 */
export interface ResolutionResult {
  success: boolean;
  resolvedTxid?: string;
  confidence?: number;
  blockNumber?: number;
  blockTimestamp?: number;
  matchedEventsCount: number;
  errorMessage?: string;
  metadata?: {
    searchFromBlock: number;
    searchToBlock: number;
    candidateMatches: number;
  };
}

/**
 * Synthetic deposit information from database
 */
interface SyntheticDeposit {
  id: number;
  dealId: string;
  chainId: ChainId;
  address: string;
  asset: AssetCode;
  txid: string;
  amount: string;
  blockHeight: number | null;
  resolution_attempts: number;
}

/**
 * Service for resolving synthetic transaction IDs to real blockchain transaction hashes.
 *
 * Process:
 * 1. Identify synthetic deposits (txids starting with "erc20-balance-")
 * 2. Calculate search window (blockHeight ± 1000 blocks)
 * 3. Query blockchain for Transfer events
 * 4. Match events by amount and recipient address
 * 5. Score matches and select best one
 * 6. Update database with resolved txid
 */
export class TxidResolver {
  private static readonly SYNTHETIC_PREFIX = 'erc20-balance-';
  private static readonly SEARCH_WINDOW_BLOCKS = 1000;
  private static readonly EXACT_MATCH_CONFIDENCE = 1.0;
  private static readonly NEAR_MATCH_CONFIDENCE = 0.9;
  private static readonly NEAR_MATCH_TOLERANCE = 0.0001; // 0.01%
  private static readonly MAX_RESOLUTION_ATTEMPTS = 5;

  constructor(
    private db: DB,
    private pluginManager: PluginManager
  ) {}

  /**
   * Check if a txid is synthetic
   */
  static isSyntheticTxid(txid: string): boolean {
    return txid.startsWith(TxidResolver.SYNTHETIC_PREFIX);
  }

  /**
   * Find all unresolved synthetic deposits that need resolution
   */
  findUnresolvedDeposits(): SyntheticDeposit[] {
    const stmt = this.db.prepare(`
      SELECT
        id, dealId, chainId, address, asset, txid, amount, blockHeight, resolution_attempts
      FROM escrow_deposits
      WHERE is_synthetic = 1
        AND resolution_status IN ('none', 'pending')
        AND resolution_attempts < ?
      ORDER BY id ASC
      LIMIT 50
    `);

    return stmt.all(TxidResolver.MAX_RESOLUTION_ATTEMPTS) as SyntheticDeposit[];
  }

  /**
   * Resolve a synthetic deposit to a real transaction hash
   */
  async resolveDeposit(deposit: SyntheticDeposit): Promise<ResolutionResult> {
    console.log(`[TxidResolver] Resolving synthetic deposit: ${deposit.txid} for deal ${deposit.dealId}`);

    try {
      // Get the chain plugin
      const plugin = this.pluginManager.getPlugin(deposit.chainId);
      if (!plugin) {
        throw new Error(`Plugin not found for chain ${deposit.chainId}`);
      }

      // Check if plugin supports transfer event resolution
      if (!('resolveTransferEvents' in plugin)) {
        throw new Error(`Chain ${deposit.chainId} does not support transfer event resolution`);
      }

      // Calculate search window
      const currentBlock = deposit.blockHeight || 0;
      const searchFromBlock = Math.max(0, currentBlock - TxidResolver.SEARCH_WINDOW_BLOCKS);
      const searchToBlock = currentBlock + TxidResolver.SEARCH_WINDOW_BLOCKS;

      console.log(`[TxidResolver] Searching blocks ${searchFromBlock} to ${searchToBlock} for ${deposit.address}`);

      // Query transfer events
      const events = await (plugin as any).resolveTransferEvents(
        deposit.asset,
        deposit.address,
        searchFromBlock,
        searchToBlock
      );

      console.log(`[TxidResolver] Found ${events.length} transfer events`);

      if (events.length === 0) {
        return {
          success: false,
          matchedEventsCount: 0,
          errorMessage: 'No transfer events found in search window',
          metadata: {
            searchFromBlock,
            searchToBlock,
            candidateMatches: 0
          }
        };
      }

      // Match events by amount
      const matches = this.matchEventsByAmount(events, deposit.amount);

      if (matches.length === 0) {
        return {
          success: false,
          matchedEventsCount: events.length,
          errorMessage: 'No events matched the deposit amount',
          metadata: {
            searchFromBlock,
            searchToBlock,
            candidateMatches: 0
          }
        };
      }

      // Select best match (highest confidence, earliest block)
      const bestMatch = this.selectBestMatch(matches);

      console.log(`[TxidResolver] Best match: ${bestMatch.txHash} with confidence ${bestMatch.confidence}`);

      // Record resolution attempt in audit table
      this.recordResolutionAttempt(deposit, bestMatch, searchFromBlock, searchToBlock, events.length);

      // Update deposit with resolved txid
      this.updateDepositWithResolution(deposit.id, bestMatch);

      return {
        success: true,
        resolvedTxid: bestMatch.txHash,
        confidence: bestMatch.confidence,
        blockNumber: bestMatch.blockNumber,
        blockTimestamp: bestMatch.blockTimestamp,
        matchedEventsCount: events.length,
        metadata: {
          searchFromBlock,
          searchToBlock,
          candidateMatches: matches.length
        }
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[TxidResolver] Error resolving deposit ${deposit.txid}:`, error);

      // Record failed attempt
      this.recordFailedAttempt(deposit, errorMessage);

      // Update resolution attempts counter
      this.incrementResolutionAttempts(deposit.id);

      return {
        success: false,
        matchedEventsCount: 0,
        errorMessage
      };
    }
  }

  /**
   * Match transfer events by amount with confidence scoring
   */
  private matchEventsByAmount(events: TransferEvent[], targetAmount: string): MatchedTransaction[] {
    const target = new Decimal(targetAmount);
    const matches: MatchedTransaction[] = [];

    for (const event of events) {
      const eventAmount = new Decimal(event.value);

      // Check for exact match
      if (eventAmount.equals(target)) {
        matches.push({
          txHash: event.txHash,
          blockNumber: event.blockNumber,
          blockTimestamp: event.blockTimestamp,
          amount: event.value,
          confidence: TxidResolver.EXACT_MATCH_CONFIDENCE,
          eventData: event
        });
        continue;
      }

      // Check for near match (within tolerance)
      const difference = eventAmount.minus(target).abs();
      const percentDiff = difference.dividedBy(target);

      if (percentDiff.lessThanOrEqualTo(TxidResolver.NEAR_MATCH_TOLERANCE)) {
        matches.push({
          txHash: event.txHash,
          blockNumber: event.blockNumber,
          blockTimestamp: event.blockTimestamp,
          amount: event.value,
          confidence: TxidResolver.NEAR_MATCH_CONFIDENCE,
          eventData: event
        });
      }
    }

    return matches;
  }

  /**
   * Select the best match from candidates
   * Prioritizes: 1) highest confidence, 2) earliest block, 3) lowest log index
   */
  private selectBestMatch(matches: MatchedTransaction[]): MatchedTransaction {
    return matches.sort((a, b) => {
      // First by confidence (descending)
      if (a.confidence !== b.confidence) {
        return b.confidence - a.confidence;
      }
      // Then by block number (ascending - earlier is better)
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }
      // Finally by log index (ascending)
      return a.eventData.logIndex - b.eventData.logIndex;
    })[0];
  }

  /**
   * Record successful resolution attempt in audit table
   */
  private recordResolutionAttempt(
    deposit: SyntheticDeposit,
    match: MatchedTransaction,
    searchFromBlock: number,
    searchToBlock: number,
    totalEventsFound: number
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO txid_resolutions (
        dealId, chainId, address, asset, synthetic_txid, resolved_txid,
        amount, blockHeight, search_from_block, search_to_block,
        matched_events_count, confidence_score, status,
        attempted_at, resolved_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const metadata = {
      totalEventsFound,
      eventLogIndex: match.eventData.logIndex,
      from: match.eventData.from,
      to: match.eventData.to
    };

    stmt.run(
      deposit.dealId,
      deposit.chainId,
      deposit.address,
      deposit.asset,
      deposit.txid,
      match.txHash,
      deposit.amount,
      match.blockNumber,
      searchFromBlock,
      searchToBlock,
      1, // matched_events_count (we only track the best match)
      match.confidence,
      'resolved',
      new Date().toISOString(),
      new Date().toISOString(),
      JSON.stringify(metadata)
    );
  }

  /**
   * Record failed resolution attempt in audit table
   */
  private recordFailedAttempt(deposit: SyntheticDeposit, errorMessage: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO txid_resolutions (
        dealId, chainId, address, asset, synthetic_txid,
        amount, status, error_message, attempted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      deposit.dealId,
      deposit.chainId,
      deposit.address,
      deposit.asset,
      deposit.txid,
      deposit.amount,
      'failed',
      errorMessage,
      new Date().toISOString()
    );
  }

  /**
   * Update escrow_deposits with resolved transaction hash
   */
  private updateDepositWithResolution(depositId: number, match: MatchedTransaction): void {
    const stmt = this.db.prepare(`
      UPDATE escrow_deposits
      SET
        original_txid = txid,
        txid = ?,
        blockHeight = ?,
        resolution_status = 'resolved',
        resolved_at = ?,
        resolution_metadata = ?
      WHERE id = ?
    `);

    const metadata = {
      confidence: match.confidence,
      resolvedBlockNumber: match.blockNumber,
      resolvedBlockTimestamp: match.blockTimestamp
    };

    stmt.run(
      match.txHash,
      match.blockNumber,
      new Date().toISOString(),
      JSON.stringify(metadata),
      depositId
    );

    console.log(`[TxidResolver] Updated deposit ${depositId} with resolved txid: ${match.txHash}`);
  }

  /**
   * Increment resolution attempts counter
   */
  private incrementResolutionAttempts(depositId: number): void {
    const stmt = this.db.prepare(`
      UPDATE escrow_deposits
      SET
        resolution_attempts = resolution_attempts + 1,
        resolution_status = CASE
          WHEN resolution_attempts + 1 >= ? THEN 'failed'
          ELSE 'pending'
        END
      WHERE id = ?
    `);

    stmt.run(TxidResolver.MAX_RESOLUTION_ATTEMPTS, depositId);
  }

  /**
   * Get resolution statistics
   */
  getResolutionStats(): {
    total: number;
    resolved: number;
    pending: number;
    failed: number;
  } {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN resolution_status = 'resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN resolution_status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN resolution_status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM escrow_deposits
      WHERE is_synthetic = 1
    `);

    const result = stmt.get() as any;
    return {
      total: result.total || 0,
      resolved: result.resolved || 0,
      pending: result.pending || 0,
      failed: result.failed || 0
    };
  }
}
