// Quick test to investigate why broker is not being used
const { EthereumPlugin } = require('./packages/chains/dist/evm/EthereumPlugin.js');

// Test 1: Check if EthereumPlugin has broker methods
const plugin = new EthereumPlugin({
  chainId: 'SEPOLIA',
  rpcUrl: 'https://eth-sepolia.g.alchemy.com/v2/demo',
  operatorAddress: '0x1234567890123456789012345678901234567890',
  brokerAddress: '0x4c164aF901b7cDc1864c91E3aB873E5cF8dce808'
});

console.log('=== BROKER INVESTIGATION ===');
console.log('1. Does plugin have swapViaBroker?', typeof plugin.swapViaBroker === 'function');
console.log('2. Does plugin have revertViaBroker?', typeof plugin.revertViaBroker === 'function');
console.log('3. Does plugin have isBrokerAvailable?', typeof plugin.isBrokerAvailable === 'function');

if (plugin.isBrokerAvailable) {
  console.log('4. Is broker available?', plugin.isBrokerAvailable());
}

console.log('5. Broker address:', plugin.brokerAddress);
console.log('6. Has broker methods check:', !!(plugin.swapViaBroker && plugin.revertViaBroker));

// Simulate Engine's canUseBroker logic
function canUseBroker(plugin) {
  const hasBrokerMethods = !!(plugin.swapViaBroker && plugin.revertViaBroker);
  if (!hasBrokerMethods) {
    console.log('   -> No broker methods found');
    return false;
  }

  if (typeof plugin.isBrokerAvailable === 'function') {
    const isBrokerConfigured = plugin.isBrokerAvailable();
    if (!isBrokerConfigured) {
      console.log('   -> Broker methods exist but broker contract not configured');
    }
    return isBrokerConfigured;
  }

  return true;
}

console.log('7. Engine.canUseBroker() would return:', canUseBroker(plugin));