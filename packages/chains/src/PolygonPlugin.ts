import { EthereumPlugin } from './EthereumPlugin';
import { ChainConfig } from './ChainPlugin';

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