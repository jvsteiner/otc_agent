/**
 * @fileoverview Production mode configuration and validation.
 * This module manages production environment restrictions for assets, chains, and amounts.
 * When PRODUCTION_MODE is enabled, only whitelisted assets and chains are allowed,
 * with configurable maximum amounts for each asset type.
 */

import { ChainId, AssetCode, DealAssetSpec } from '@otc-broker/core';
import { parseAssetCode } from '@otc-broker/core';

/**
 * Production configuration loaded from environment variables.
 */
interface ProductionConfig {
  /** Whether production mode is enabled (restricts assets and chains) */
  productionMode: boolean;
  /** Allowed chain IDs in production mode */
  allowedChains: Set<ChainId>;
  /** Allowed asset codes in production mode (normalized to uppercase) */
  allowedAssets: Set<string>;
  /** Maximum amounts by asset symbol (e.g., 'ETH' => '10') */
  maxAmounts: Map<string, string>;
}

/**
 * Loads and caches production configuration from environment variables.
 * This function is memoized to avoid repeated environment parsing.
 */
let cachedConfig: ProductionConfig | null = null;

function loadConfig(): ProductionConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const productionMode = process.env.PRODUCTION_MODE === 'true';

  // Parse allowed chains (comma-separated)
  const allowedChainsStr = process.env.ALLOWED_CHAINS || '';
  const allowedChains = new Set<ChainId>(
    allowedChainsStr
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0) as ChainId[]
  );

  // Parse allowed assets (comma-separated, case-insensitive)
  const allowedAssetsStr = process.env.ALLOWED_ASSETS || '';
  const allowedAssets = new Set<string>(
    allowedAssetsStr
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(s => s.length > 0)
  );

  // Parse max amounts (format: ASSET=AMOUNT,ASSET=AMOUNT)
  const maxAmounts = new Map<string, string>();
  const maxAmountsStr = process.env.MAX_AMOUNTS || '';
  if (maxAmountsStr) {
    const pairs = maxAmountsStr.split(',');
    for (const pair of pairs) {
      const [asset, amount] = pair.split('=').map(s => s.trim());
      if (asset && amount) {
        maxAmounts.set(asset.toUpperCase(), amount);
      }
    }
  }

  // Also check individual MAX_AMOUNT_* environment variables
  const envKeys = Object.keys(process.env);
  for (const key of envKeys) {
    if (key.startsWith('MAX_AMOUNT_')) {
      const asset = key.replace('MAX_AMOUNT_', '').toUpperCase();
      const amount = process.env[key];
      if (amount) {
        maxAmounts.set(asset, amount);
      }
    }
  }

  cachedConfig = {
    productionMode,
    allowedChains,
    allowedAssets,
    maxAmounts
  };

  // Log configuration on startup
  if (productionMode) {
    console.log('🔐 Production mode ENABLED with restrictions:');
    console.log('  Allowed chains:', Array.from(allowedChains).join(', ') || 'ALL');
    console.log('  Allowed assets:', Array.from(allowedAssets).join(', ') || 'ALL');
    console.log('  Max amounts:', Array.from(maxAmounts.entries()).map(([k, v]) => `${k}=${v}`).join(', ') || 'NO LIMITS');
  } else {
    console.log('🔓 Production mode DISABLED - all assets and chains allowed');
  }

  return cachedConfig;
}

/**
 * Checks if production mode is currently enabled.
 *
 * @returns True if production mode is enabled, false otherwise
 */
export function isProductionMode(): boolean {
  return loadConfig().productionMode;
}

/**
 * Checks if a specific blockchain chain is allowed in production mode.
 *
 * @param chainId - The chain identifier to check
 * @returns True if the chain is allowed, false if restricted
 *
 * @example
 * isChainAllowed('ETH') // true if ETH is in ALLOWED_CHAINS
 */
export function isChainAllowed(chainId: ChainId): boolean {
  const config = loadConfig();

  // In dev mode, all chains are allowed
  if (!config.productionMode) {
    return true;
  }

  // If no chains specified, allow all
  if (config.allowedChains.size === 0) {
    return true;
  }

  return config.allowedChains.has(chainId);
}

/**
 * Normalizes an asset identifier for comparison.
 * Handles various asset formats including ERC20 addresses and chain suffixes.
 *
 * @param asset - The asset code to normalize
 * @returns Normalized asset identifier (uppercase, without chain suffix)
 */
function normalizeAsset(asset: AssetCode): string {
  // Handle ERC20 contract addresses - normalize to lowercase for comparison
  if (asset.startsWith('ERC20:')) {
    return asset.toUpperCase();
  }

  // Handle SPL tokens
  if (asset.startsWith('SPL:')) {
    return asset.toUpperCase();
  }

  // Remove @CHAIN suffix if present (e.g., MATIC@POLYGON -> MATIC)
  const baseAsset = asset.includes('@') ? asset.split('@')[0] : asset;

  return baseAsset.toUpperCase();
}

/**
 * Checks if a specific asset is allowed in production mode.
 *
 * @param asset - The asset code to check
 * @param chainId - The chain where the asset resides
 * @returns True if the asset is allowed, false if restricted
 *
 * @example
 * isAssetAllowed('ETH', 'ETH') // true if ETH is in ALLOWED_ASSETS
 * isAssetAllowed('ERC20:0xA0b86991...', 'ETH') // checks if USDC address is allowed
 */
export function isAssetAllowed(asset: AssetCode, chainId: ChainId): boolean {
  const config = loadConfig();

  // In dev mode, all assets are allowed
  if (!config.productionMode) {
    return true;
  }

  // If no assets specified, allow all
  if (config.allowedAssets.size === 0) {
    return true;
  }

  // Try to parse the asset to get its metadata
  const assetConfig = parseAssetCode(asset, chainId);

  // Check various representations of the asset
  const normalizedAsset = normalizeAsset(asset);

  // Check if the normalized asset is allowed
  if (config.allowedAssets.has(normalizedAsset)) {
    return true;
  }

  // For parsed assets, also check by symbol
  if (assetConfig) {
    if (config.allowedAssets.has(assetConfig.assetSymbol.toUpperCase())) {
      return true;
    }

    // For ERC20 tokens, check the contract address
    if (assetConfig.contractAddress) {
      const erc20Key = `ERC20:${assetConfig.contractAddress.toUpperCase()}`;
      if (config.allowedAssets.has(erc20Key)) {
        return true;
      }

      // Also check just the address
      if (config.allowedAssets.has(assetConfig.contractAddress.toUpperCase())) {
        return true;
      }
    }
  }

  // Check with @CHAIN suffix
  const withChainSuffix = `${normalizedAsset}@${chainId}`.toUpperCase();
  if (config.allowedAssets.has(withChainSuffix)) {
    return true;
  }

  return false;
}

/**
 * Gets the maximum allowed amount for a specific asset.
 *
 * @param asset - The asset code to check
 * @returns Maximum amount as string, or null if no limit
 *
 * @example
 * getMaxAmount('ETH') // '10' if MAX_AMOUNT_ETH=10
 * getMaxAmount('USDT') // null if no limit set
 */
export function getMaxAmount(asset: AssetCode): string | null {
  const config = loadConfig();

  // In dev mode, no limits
  if (!config.productionMode) {
    return null;
  }

  const normalizedAsset = normalizeAsset(asset);

  // Check for max amount
  if (config.maxAmounts.has(normalizedAsset)) {
    return config.maxAmounts.get(normalizedAsset)!;
  }

  // For assets with @CHAIN suffix, also check without suffix
  const baseAsset = asset.includes('@') ? asset.split('@')[0].toUpperCase() : normalizedAsset;
  if (config.maxAmounts.has(baseAsset)) {
    return config.maxAmounts.get(baseAsset)!;
  }

  return null;
}

/**
 * Validates that deal amounts don't exceed configured limits in production mode.
 * Throws an error if validation fails.
 *
 * @param alice - Alice's asset specification
 * @param bob - Bob's asset specification
 * @throws Error if validation fails with user-friendly message
 *
 * @example
 * validateDealAmounts(
 *   { chainId: 'ETH', asset: 'ETH', amount: '15' },
 *   { chainId: 'POLYGON', asset: 'MATIC', amount: '1000' }
 * )
 * // Throws if ETH max is 10 or MATIC max is 500
 */
export function validateDealAmounts(alice: DealAssetSpec, bob: DealAssetSpec): void {
  const config = loadConfig();

  // Skip validation in dev mode
  if (!config.productionMode) {
    return;
  }

  // Validate chains
  if (!isChainAllowed(alice.chainId)) {
    throw new Error(`Chain ${alice.chainId} is not currently supported in production mode`);
  }

  if (!isChainAllowed(bob.chainId)) {
    throw new Error(`Chain ${bob.chainId} is not currently supported in production mode`);
  }

  // Validate assets
  if (!isAssetAllowed(alice.asset, alice.chainId)) {
    const assetDisplay = getAssetDisplay(alice.asset, alice.chainId);
    throw new Error(`Asset ${assetDisplay} is not currently supported in production mode`);
  }

  if (!isAssetAllowed(bob.asset, bob.chainId)) {
    const assetDisplay = getAssetDisplay(bob.asset, bob.chainId);
    throw new Error(`Asset ${assetDisplay} is not currently supported in production mode`);
  }

  // Validate amounts
  validateAmount(alice);
  validateAmount(bob);
}

/**
 * Validates a single asset amount against configured limits.
 *
 * @param spec - Asset specification to validate
 * @throws Error if amount exceeds configured maximum
 */
function validateAmount(spec: DealAssetSpec): void {
  const maxAmount = getMaxAmount(spec.asset);

  if (maxAmount !== null) {
    const amount = parseFloat(spec.amount);
    const max = parseFloat(maxAmount);

    if (!isNaN(amount) && !isNaN(max) && amount > max) {
      const assetDisplay = getAssetDisplay(spec.asset, spec.chainId);
      throw new Error(
        `Maximum amount for ${assetDisplay} is ${maxAmount}, you requested ${spec.amount}`
      );
    }
  }
}

/**
 * Gets a user-friendly display name for an asset.
 *
 * @param asset - The asset code
 * @param chainId - The chain ID
 * @returns User-friendly asset display string
 */
function getAssetDisplay(asset: AssetCode, chainId: ChainId): string {
  // Try to parse for better display
  const assetConfig = parseAssetCode(asset, chainId);
  if (assetConfig) {
    return `${assetConfig.assetSymbol} on ${chainId}`;
  }

  // Fallback to raw asset code
  return asset;
}

/**
 * Gets a summary of current production restrictions for logging or display.
 *
 * @returns Object containing production mode status and restrictions
 */
export function getProductionRestrictions() {
  const config = loadConfig();

  return {
    enabled: config.productionMode,
    allowedChains: config.allowedChains.size > 0 ? Array.from(config.allowedChains) : 'ALL',
    allowedAssets: config.allowedAssets.size > 0 ? Array.from(config.allowedAssets) : 'ALL',
    maxAmounts: config.maxAmounts.size > 0 ? Object.fromEntries(config.maxAmounts) : 'NO LIMITS'
  };
}

/**
 * Clears the cached configuration (useful for testing).
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}