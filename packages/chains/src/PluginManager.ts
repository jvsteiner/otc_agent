/**
 * @fileoverview Plugin manager for registering and retrieving blockchain plugins.
 * Acts as a factory and registry for chain-specific plugin implementations.
 * Handles plugin instantiation based on chain ID and maintains plugin lifecycle.
 */

import { ChainId } from '@otc-broker/core';
import { ChainPlugin, ChainConfig } from './ChainPlugin';
import { UnicityPlugin } from './UnicityPlugin';
import { EvmPlugin } from './EvmPlugin';
import { EthereumPlugin } from './EthereumPlugin';
import { PolygonPlugin } from './PolygonPlugin';
import { BasePlugin } from './BasePlugin';

/**
 * Manages the lifecycle and registry of blockchain plugins.
 * Instantiates appropriate plugin implementations based on chain ID
 * and provides centralized access to all registered plugins.
 */
export class PluginManager {
  private plugins = new Map<ChainId, ChainPlugin>();
  private database?: any;

  /**
   * Create a new PluginManager instance.
   * @param database - Optional database reference passed to plugins for persistence
   */
  constructor(database?: any) {
    this.database = database;
  }

  /**
   * Register a new blockchain plugin with the manager.
   * Instantiates the appropriate plugin class based on chain ID and initializes it.
   * @param config - Chain configuration including chain ID, RPC URLs, and parameters
   * @throws Error if the chain ID is not supported
   */
  async registerPlugin(config: ChainConfig): Promise<void> {
    // Pass database to config if available
    if (this.database && !config.database) {
      config.database = this.database;
    }
    
    let plugin: ChainPlugin;
    
    switch (config.chainId) {
      case 'UNICITY':
        plugin = new UnicityPlugin();
        break;
      case 'ETH':
        plugin = new EthereumPlugin(config);
        break;
      case 'POLYGON':
        plugin = new PolygonPlugin(config);
        break;
      case 'BASE':
        plugin = new BasePlugin(config);
        break;
      default:
        if (config.chainId.startsWith('EVM:')) {
          plugin = new EvmPlugin(config.chainId);
        } else {
          throw new Error(`Unsupported chain: ${config.chainId}`);
        }
    }
    
    await plugin.init(config);
    this.plugins.set(config.chainId, plugin);
  }

  /**
   * Retrieve a registered plugin by chain ID.
   * @param chainId - The blockchain identifier
   * @returns The registered plugin instance
   * @throws Error if no plugin is registered for the given chain ID
   */
  getPlugin(chainId: ChainId): ChainPlugin {
    const plugin = this.plugins.get(chainId);
    if (!plugin) {
      console.error(`[PluginManager] Available plugins:`, Array.from(this.plugins.keys()));
      throw new Error(`Plugin not registered for chain: ${chainId}`);
    }
    console.log(`[PluginManager] Returning ${plugin.constructor.name} for chain ${chainId}`);
    return plugin;
  }

  /**
   * Get all registered plugins.
   * @returns Map of chain IDs to plugin instances
   */
  getAllPlugins(): Map<ChainId, ChainPlugin> {
    return this.plugins;
  }
}