import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
import { DB, initDatabase } from './db/database';
import { runMigrations } from './db/migrate';
import { RpcServer } from './api/rpc-server';
import { Engine } from './engine/Engine';
import { PluginManager, ChainConfig } from '@otc-broker/chains';

async function main() {
  console.log('Starting OTC Broker Engine...');
  console.log('Electrum URL:', process.env.UNICITY_ELECTRUM || 'not set, using default');
  
  // Initialize database
  const db = initDatabase();
  runMigrations(db);
  
  // Initialize plugin manager
  const pluginManager = new PluginManager();
  
  // Register Unicity plugin (mandatory)
  await pluginManager.registerPlugin({
    chainId: 'UNICITY',
    electrumUrl: process.env.UNICITY_ELECTRUM || 'wss://fulcrum.unicity.network:50004',
    confirmations: parseInt(process.env.UNICITY_CONFIRMATIONS || '6'),
    collectConfirms: parseInt(process.env.UNICITY_COLLECT_CONFIRMS || '6'),
    operator: { address: process.env.UNICITY_OPERATOR_ADDRESS || 'UNI_OPERATOR_ADDRESS' },
    hotWalletSeed: process.env.HOT_WALLET_SEED,
  });
  
  // Register ETH plugin if configured
  if (process.env.ETH_RPC) {
    await pluginManager.registerPlugin({
      chainId: 'ETH',
      rpcUrl: process.env.ETH_RPC,
      confirmations: parseInt(process.env.ETH_CONFIRMATIONS || '3'),
      collectConfirms: parseInt(process.env.ETH_COLLECT_CONFIRMS || '3'),
      operator: { address: process.env.ETH_OPERATOR_ADDRESS || '0x0' },
      hotWalletSeed: process.env.HOT_WALLET_SEED,
    });
  }
  
  // Register Polygon plugin if configured
  if (process.env.POLYGON_RPC) {
    await pluginManager.registerPlugin({
      chainId: 'POLYGON',
      rpcUrl: process.env.POLYGON_RPC,
      confirmations: parseInt(process.env.POLYGON_CONFIRMATIONS || '64'),
      collectConfirms: parseInt(process.env.POLYGON_COLLECT_CONFIRMS || '64'),
      operator: { address: process.env.POLYGON_OPERATOR_ADDRESS || '0x0' },
      hotWalletSeed: process.env.HOT_WALLET_SEED,
    });
  }
  
  // Initialize engine
  const engine = new Engine(db, pluginManager);
  
  // Start RPC server
  const rpcServer = new RpcServer(db, pluginManager);
  const port = parseInt(process.env.PORT || '8080');
  rpcServer.start(port);
  
  // Start engine loop
  engine.start();
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down...');
    engine.stop();
    db.close();
    process.exit(0);
  });
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});