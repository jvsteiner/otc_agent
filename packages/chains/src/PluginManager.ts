import { ChainId } from '@otc-broker/core';
import { ChainPlugin, ChainConfig } from './ChainPlugin';
import { UnicityPlugin } from './UnicityPlugin';
import { UnicityMockPlugin } from './UnicityMockPlugin';
import { EvmPlugin } from './EvmPlugin';

export class PluginManager {
  private plugins = new Map<ChainId, ChainPlugin>();

  async registerPlugin(config: ChainConfig): Promise<void> {
    let plugin: ChainPlugin;
    
    switch (config.chainId) {
      case 'UNICITY':
        // Use mock plugin if MOCK_MODE is set
        if (process.env.MOCK_MODE === 'true') {
          plugin = new UnicityMockPlugin();
        } else {
          plugin = new UnicityPlugin();
        }
        break;
      case 'ETH':
      case 'POLYGON':
        plugin = new EvmPlugin(config.chainId);
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