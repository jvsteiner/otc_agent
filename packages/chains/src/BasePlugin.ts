import { EthereumPlugin } from './EthereumPlugin';
import { ChainConfig } from './ChainPlugin';

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