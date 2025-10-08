/**
 * @fileoverview Main entry point for the OTC Broker Engine backend server.
 * Initializes the database, plugin manager, RPC server, and processing engine.
 * Manages the lifecycle of all backend components including graceful shutdown.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
import { DB, initDatabase } from './db/database';
import { runMigrations } from './db/migrate';
import { RpcServer } from './api/rpc-server';
import { Engine } from './engine/Engine';
import { PluginManager, ChainConfig } from '@otc-broker/chains';

/**
 * Main entry point for the backend server.
 * Initializes all components in the correct order:
 * 1. Database with migrations
 * 2. Plugin manager with chain configurations
 * 3. Processing engine
 * 4. RPC API server
 */
async function main() {
  console.log('Starting OTC Broker Engine... (v2)'); // Force reload
  console.log('Electrum URL:', process.env.UNICITY_ELECTRUM || 'not set, using default');
  
  // Initialize database
  const db = initDatabase();
  runMigrations(db);
  
  // Initialize plugin manager with database for wallet index persistence
  const pluginManager = new PluginManager(db);
  
  // Register Unicity plugin (mandatory)
  await pluginManager.registerPlugin({
    chainId: 'UNICITY',
    electrumUrl: process.env.UNICITY_ELECTRUM || 'wss://fulcrum.unicity.network:50004',
    confirmations: parseInt(process.env.UNICITY_CONFIRMATIONS || '6'),
    collectConfirms: parseInt(process.env.UNICITY_COLLECT_CONFIRMS || '6'),
    operator: { address: process.env.UNICITY_OPERATOR_ADDRESS || 'UNI_OPERATOR_ADDRESS' },
    hotWalletSeed: process.env.HOT_WALLET_SEED,
  });
  
  // Register ETH plugin (always enabled with default or configured RPC)
  await pluginManager.registerPlugin({
    chainId: 'ETH',
    rpcUrl: process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com',
    confirmations: parseInt(process.env.ETH_CONFIRMATIONS || '12'),
    collectConfirms: parseInt(process.env.ETH_COLLECT_CONFIRMS || '12'),
    operator: { address: process.env.ETH_OPERATOR_ADDRESS || '0x0000000000000000000000000000000000000000' },
    hotWalletSeed: process.env.HOT_WALLET_SEED,
  });
  
  // Register Polygon plugin (always enabled with default or configured RPC)
  await pluginManager.registerPlugin({
    chainId: 'POLYGON',
    rpcUrl: process.env.POLYGON_RPC || 'https://polygon-mainnet.g.alchemy.com/v2/9LkJ1e22_qxEBFxOQ4pD3',
    confirmations: parseInt(process.env.POLYGON_CONFIRMATIONS || '30'),
    collectConfirms: parseInt(process.env.POLYGON_COLLECT_CONFIRMS || '30'),
    operator: { address: process.env.POLYGON_OPERATOR_ADDRESS || '0x0000000000000000000000000000000000000000' },
    hotWalletSeed: process.env.HOT_WALLET_SEED,
  });
  
  // Register Base plugin (always enabled with default or configured RPC)
  await pluginManager.registerPlugin({
    chainId: 'BASE',
    rpcUrl: process.env.BASE_RPC || 'https://base-rpc.publicnode.com',
    confirmations: parseInt(process.env.BASE_CONFIRMATIONS || '12'),
    collectConfirms: parseInt(process.env.BASE_COLLECT_CONFIRMS || '12'),
    operator: { address: process.env.BASE_OPERATOR_ADDRESS || '0x0000000000000000000000000000000000000000' },
    hotWalletSeed: process.env.HOT_WALLET_SEED,
  });
  
  // Initialize engine
  const engine = new Engine(db, pluginManager);
  
  // Start RPC server
  const rpcServer = new RpcServer(db, pluginManager);
  const port = parseInt(process.env.PORT || '8080');
  rpcServer.start(port);
  
  // Start engine loop
  await engine.start();
  
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