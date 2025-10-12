#!/usr/bin/env node

/**
 * Test script to verify Sepolia deposit detection
 */

const { EthereumPlugin } = require('./packages/chains/dist/EthereumPlugin.js');

async function testSepoliaDeposits() {
  console.log('=== Testing Sepolia Deposit Detection ===\n');

  const plugin = new EthereumPlugin('SEPOLIA');
  await plugin.init({
    chainId: 'SEPOLIA',
    rpcUrl: 'https://eth-sepolia.g.alchemy.com/v2/9LkJ1e22_qxEBFxOQ4pD3',
    confirmations: 3,
    collectConfirms: 3,
    operator: { address: '0xEd3f3F5974599f6455B06bB566C267cc64A6F1d1' },
    hotWalletSeed: 'otc-broker-dev-seed-unicity-2024',
    brokerAddress: '0x4c164aF901b7cDc1864c91E3aB873E5cF8dce808'
  });

  const escrowAddress = '0x2B77e9b2C6748b4E7684d275226FB6Af25071e10';

  console.log('Test 1: Query with minConf=0 (what engine uses in COLLECTION stage)');
  const result0 = await plugin.listConfirmedDeposits('ETH', escrowAddress, 0);
  console.log('Result:', JSON.stringify(result0, null, 2));

  console.log('\nTest 2: Query with minConf=3 (what engine uses in WAITING stage)');
  const result3 = await plugin.listConfirmedDeposits('ETH', escrowAddress, 3);
  console.log('Result:', JSON.stringify(result3, null, 2));

  console.log('\nTest 3: Query with ETH@SEPOLIA asset code');
  const result4 = await plugin.listConfirmedDeposits('ETH@SEPOLIA', escrowAddress, 0);
  console.log('Result:', JSON.stringify(result4, null, 2));

  console.log('\n=== All tests completed ===');
}

testSepoliaDeposits().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
