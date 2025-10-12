/**
 * @fileoverview Base (Coinbase L2) blockchain plugin implementation.
 * Extends EthereumPlugin with Base-specific configuration.
 */

import { EthereumPlugin } from './EthereumPlugin';
import { ChainConfig } from './ChainPlugin';

/**
 * Plugin implementation for Base L2 (Coinbase's Optimistic Rollup).
 * Inherits all EVM functionality from EthereumPlugin with Base-specific defaults:
 * - Optimistic rollup with faster finality than L1
 * - Lower gas costs compared to Ethereum mainnet
 * - ETH as native currency
 */
export class BasePlugin extends EthereumPlugin {
  constructor(config?: Partial<ChainConfig>) {
    // Override defaults for Base
    const baseConfig: Partial<ChainConfig> = {
      ...config,
      chainId: 'BASE',
      rpcUrl: config?.rpcUrl || 'https://base-rpc.publicnode.com',
      confirmations: config?.confirmations || 12,
      collectConfirms: config?.collectConfirms || 12,
    };

    super(baseConfig);
  }
}