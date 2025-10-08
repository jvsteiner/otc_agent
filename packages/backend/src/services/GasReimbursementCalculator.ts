/**
 * @fileoverview Gas Reimbursement Calculator for ERC-20 token swaps.
 *
 * This service calculates gas cost reimbursements to be paid to the tank wallet
 * when it funds escrows with gas for ERC-20 token transfers. The reimbursement
 * is paid in USDT or other stablecoins from the escrow's balance.
 *
 * Key formulas:
 * - estimatedTotalGas = actualGasUsed * 4 * 1.1  (4 txs + 10% margin)
 * - nativeCostWei = estimatedTotalGas * gasPriceWei
 * - nativeUsdValue = (nativeCostWei / 10^18) * nativeUsdRate
 * - tokenAmount = ceiling((nativeUsdValue / tokenUsdRate) * 1.05)  (5% slippage)
 */

import { Deal, AssetCode, ChainId } from '@otc-broker/core';
import { ChainPlugin } from '@otc-broker/chains';
import Decimal from 'decimal.js';

/**
 * Result of gas reimbursement calculation
 */
export interface GasReimbursementResult {
  /** Whether reimbursement should be processed */
  shouldReimburse: boolean;
  /** Selected token for reimbursement (USDT, USDC, etc) */
  token?: AssetCode;
  /** Chain where reimbursement will be paid */
  chainId?: ChainId;
  /** Escrow that will pay reimbursement (A or B) */
  escrowSide?: 'A' | 'B';
  /** Detailed calculation breakdown */
  calculation?: {
    actualGasUsed: string;
    gasPrice: string;
    estimatedTotalGas: string;
    nativeCostWei: string;
    nativeUsdValue: string;
    nativeUsdRate: string;
    tokenUsdRate?: string;
    tokenAmount?: string;
    calculatedAt: string;
  };
  /** Reason if reimbursement was skipped */
  skipReason?: string;
}

/**
 * Service for calculating gas cost reimbursements for ERC-20 swaps
 */
export class GasReimbursementCalculator {
  // Configuration constants
  private static readonly TX_MULTIPLIER = 4;          // Expected 4 transactions
  private static readonly MARGIN_MULTIPLIER = 1.1;    // 10% margin
  private static readonly SLIPPAGE_MULTIPLIER = 1.05; // 5% slippage
  private static readonly RETRY_ATTEMPTS = 3;
  private static readonly RETRY_DELAY_MS = 1000;

  /**
   * Check if a deal qualifies for gas reimbursement
   *
   * Eligibility criteria:
   * - Deal must involve ERC-20 token (not native-only)
   * - Must be on EVM chain (ETH/POLYGON/BASE)
   * - At least one escrow must have been gas-funded by tank
   *
   * @param deal - The deal to check
   * @returns True if deal qualifies for gas reimbursement
   */
  shouldReimburse(deal: Deal): boolean {
    // Check if deal involves EVM chains
    const evmChains = ['ETH', 'POLYGON', 'BASE'] as const;
    const aliceIsEVM = evmChains.includes(deal.alice.chainId as any);
    const bobIsEVM = evmChains.includes(deal.bob.chainId as any);

    if (!aliceIsEVM && !bobIsEVM) {
      return false; // No EVM chains involved
    }

    // Check if deal involves ERC-20 tokens (not just native)
    const aliceIsERC20 = deal.alice.asset.startsWith('ERC20:');
    const bobIsERC20 = deal.bob.asset.startsWith('ERC20:');

    if (!aliceIsERC20 && !bobIsERC20) {
      return false; // No ERC-20 tokens involved
    }

    // Must have gas reimbursement field initialized
    if (!deal.gasReimbursement) {
      return false;
    }

    return deal.gasReimbursement.enabled;
  }

  /**
   * Select which token to use for reimbursement
   *
   * Priority:
   * 1. ERC-20 token from gas-funded escrow (if it's a stablecoin like USDT/USDC)
   * 2. Any ERC-20 token in the deal
   *
   * @param deal - The deal to analyze
   * @returns Selected token and chain, or undefined if no suitable token found
   */
  selectReimbursementToken(deal: Deal): { token: AssetCode; chainId: ChainId; escrowSide: 'A' | 'B' } | undefined {
    if (!deal.gasReimbursement?.escrowSide) {
      return undefined;
    }

    const side = deal.gasReimbursement.escrowSide;
    const spec = side === 'A' ? deal.alice : deal.bob;

    // Check if the asset is an ERC-20 token
    if (spec.asset.startsWith('ERC20:')) {
      return {
        token: spec.asset,
        chainId: spec.chainId,
        escrowSide: side
      };
    }

    // Check the other side
    const otherSide = side === 'A' ? 'B' : 'A';
    const otherSpec = otherSide === 'A' ? deal.alice : deal.bob;

    if (otherSpec.asset.startsWith('ERC20:')) {
      return {
        token: otherSpec.asset,
        chainId: otherSpec.chainId,
        escrowSide: otherSide
      };
    }

    return undefined;
  }

  /**
   * Calculate gas reimbursement amount
   *
   * @param deal - The deal
   * @param actualGasUsed - Actual gas used from first SWAP transaction
   * @param gasPrice - Gas price in wei
   * @param plugin - Chain plugin for price oracle access
   * @returns Calculation result with reimbursement amount
   */
  async calculateReimbursement(
    deal: Deal,
    actualGasUsed: string,
    gasPrice: string,
    plugin: ChainPlugin
  ): Promise<GasReimbursementResult> {
    console.log('[GasReimbursement] Starting calculation:', {
      dealId: deal.id,
      actualGasUsed,
      gasPrice
    });

    // Check eligibility
    if (!this.shouldReimburse(deal)) {
      return {
        shouldReimburse: false,
        skipReason: 'Deal does not qualify for gas reimbursement'
      };
    }

    // Select reimbursement token
    const tokenSelection = this.selectReimbursementToken(deal);
    if (!tokenSelection) {
      return {
        shouldReimburse: false,
        skipReason: 'No suitable ERC-20 token found for reimbursement'
      };
    }

    console.log('[GasReimbursement] Token selection:', tokenSelection);

    try {
      // Step 1: Calculate estimated total gas (4 txs + 10% margin)
      const gasUsedDecimal = new Decimal(actualGasUsed);
      const estimatedTotalGas = gasUsedDecimal
        .mul(GasReimbursementCalculator.TX_MULTIPLIER)
        .mul(GasReimbursementCalculator.MARGIN_MULTIPLIER)
        .toFixed(0, Decimal.ROUND_UP);

      console.log('[GasReimbursement] Estimated total gas:', estimatedTotalGas);

      // Step 2: Calculate native cost in wei
      const gasPriceDecimal = new Decimal(gasPrice);
      const nativeCostWei = new Decimal(estimatedTotalGas)
        .mul(gasPriceDecimal)
        .toFixed(0, Decimal.ROUND_UP);

      console.log('[GasReimbursement] Native cost (wei):', nativeCostWei);

      // Step 3: Get native USD rate with retry
      const nativeUsdRate = await this.getNativeUsdRateWithRetry(plugin);
      if (!nativeUsdRate) {
        return {
          shouldReimburse: false,
          skipReason: 'Failed to fetch native token USD price after retries'
        };
      }

      console.log('[GasReimbursement] Native USD rate:', nativeUsdRate);

      // Step 4: Convert native cost to USD
      const nativeCostEth = new Decimal(nativeCostWei).div(new Decimal(10).pow(18));
      const nativeUsdValue = nativeCostEth.mul(nativeUsdRate).toFixed(6, Decimal.ROUND_UP);

      console.log('[GasReimbursement] Native USD value:', nativeUsdValue);

      // Step 5: For stablecoins, 1 token = $1, so token amount = USD value with slippage
      // For other tokens, we'd need to get token/USD rate (not implemented for now)
      const tokenUsdRate = this.isStablecoin(tokenSelection.token) ? '1.0' : undefined;

      if (!tokenUsdRate) {
        return {
          shouldReimburse: false,
          skipReason: 'Token price oracle not available (only stablecoins supported)'
        };
      }

      // Step 6: Calculate token amount with 5% slippage, using ceiling
      const tokenAmount = new Decimal(nativeUsdValue)
        .div(tokenUsdRate)
        .mul(GasReimbursementCalculator.SLIPPAGE_MULTIPLIER)
        .toFixed(6, Decimal.ROUND_UP); // Use ceiling (ROUND_UP)

      console.log('[GasReimbursement] Token amount (with slippage):', tokenAmount);

      return {
        shouldReimburse: true,
        token: tokenSelection.token,
        chainId: tokenSelection.chainId,
        escrowSide: tokenSelection.escrowSide,
        calculation: {
          actualGasUsed,
          gasPrice,
          estimatedTotalGas,
          nativeCostWei,
          nativeUsdValue,
          nativeUsdRate,
          tokenUsdRate,
          tokenAmount,
          calculatedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('[GasReimbursement] Calculation error:', error);
      return {
        shouldReimburse: false,
        skipReason: `Calculation error: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Get native token USD rate with retry logic
   */
  private async getNativeUsdRateWithRetry(plugin: ChainPlugin): Promise<string | null> {
    for (let attempt = 1; attempt <= GasReimbursementCalculator.RETRY_ATTEMPTS; attempt++) {
      try {
        console.log(`[GasReimbursement] Fetching native USD rate (attempt ${attempt}/${GasReimbursementCalculator.RETRY_ATTEMPTS})`);

        const result = await plugin.quoteNativeForUSD('1');
        const rate = result.quote.price;

        console.log(`[GasReimbursement] Received rate: ${rate} from ${result.quote.source}`);
        return rate;
      } catch (error) {
        console.error(`[GasReimbursement] Price fetch failed (attempt ${attempt}):`, error);

        if (attempt < GasReimbursementCalculator.RETRY_ATTEMPTS) {
          // Exponential backoff
          const delay = GasReimbursementCalculator.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(`[GasReimbursement] Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.error('[GasReimbursement] All retry attempts exhausted');
    return null;
  }

  /**
   * Check if a token is a stablecoin (1 token = $1)
   */
  private isStablecoin(asset: AssetCode): boolean {
    const assetUpper = asset.toUpperCase();

    // Common stablecoin symbols
    const stablecoins = ['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDP'];

    // Known stablecoin contract addresses (lowercase for comparison)
    const stablecoinAddresses: { [key: string]: string } = {
      // USDT
      '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT', // Ethereum
      '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 'USDT', // Polygon
      // USDC
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC', // Ethereum
      '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'USDC', // Polygon (old)
      '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'USDC', // Polygon (new)
      // DAI
      '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI', // Ethereum
      '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': 'DAI', // Polygon
    };

    // Check for ERC20 contract address first
    if (asset.startsWith('ERC20:')) {
      const address = asset.substring(6).split('@')[0].toLowerCase(); // Remove "ERC20:" and chain suffix
      if (stablecoinAddresses[address]) {
        return true;
      }
    }

    // Check symbol-based patterns
    return stablecoins.some(stable =>
      assetUpper.includes(stable) ||
      assetUpper === stable ||
      assetUpper.startsWith(`${stable}@`) ||
      assetUpper.includes(`:${stable}`)
    );
  }
}
