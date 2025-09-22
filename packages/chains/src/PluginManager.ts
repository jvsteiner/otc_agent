import { ChainId } from '@otc-broker/core';
import { ChainPlugin, ChainConfig } from './ChainPlugin';
import { UnicityPlugin } from './UnicityPlugin';
import { EvmPlugin } from './EvmPlugin';
import { EthereumPlugin } from './EthereumPlugin';
import { PolygonPlugin } from './PolygonPlugin';
import { BasePlugin } from './BasePlugin';

export class PluginManager {
  private plugins = new Map<ChainId, ChainPlugin>();
  private database?: any;

  constructor(database?: any) {
    this.database = database;
  }

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

  getPlugin(chainId: ChainId): ChainPlugin {
    const plugin = this.plugins.get(chainId);
    if (!plugin) {
      throw new Error(`Plugin not registered for chain: ${chainId}`);
    }
    return plugin;
  }

  getAllPlugins(): Map<ChainId, ChainPlugin> {
    return this.plugins;
  }
}