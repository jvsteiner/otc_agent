/**
 * @fileoverview Polygon (MATIC) blockchain plugin implementation.
 * Extends EthereumPlugin with Polygon-specific configuration and parameters.
 */

import { EthereumPlugin } from './EthereumPlugin';
import { ChainConfig } from './ChainPlugin';

/**
 * Plugin implementation for Polygon PoS chain.
 * Inherits all EVM functionality from EthereumPlugin with Polygon-specific defaults:
 * - Higher confirmation requirements (30 blocks due to reorg risk)
 * - Polygon RPC endpoints
 * - MATIC as native currency
 */
export class PolygonPlugin extends EthereumPlugin {
  constructor(config?: Partial<ChainConfig>) {
    // Override defaults for Polygon
    const polygonConfig: Partial<ChainConfig> = {
      ...config,
      chainId: 'POLYGON',
      rpcUrl: config?.rpcUrl || 'https://polygon-bor-rpc.publicnode.com',
      confirmations: config?.confirmations || 30, // Polygon needs more confirmations
      collectConfirms: config?.collectConfirms || 30,
    };

    super(polygonConfig);
  }
}