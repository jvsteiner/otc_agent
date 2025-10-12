#!/usr/bin/env node

// Comprehensive test to verify broker flow from config to execution
require('dotenv').config();

async function testBrokerFlow() {
  console.log('=== BROKER FLOW INVESTIGATION ===\n');

  // Step 1: Check environment configuration
  console.log('1. ENVIRONMENT CONFIGURATION:');
  console.log('   SEPOLIA_BROKER_ADDRESS:', process.env.SEPOLIA_BROKER_ADDRESS || 'NOT SET');
  console.log('   SEPOLIA_RPC:', process.env.SEPOLIA_RPC ? 'SET' : 'NOT SET');
  console.log('   SEPOLIA_OPERATOR_ADDRESS:', process.env.SEPOLIA_OPERATOR_ADDRESS || 'NOT SET');
  console.log('');

  // Step 2: Test plugin initialization
  console.log('2. PLUGIN INITIALIZATION:');

  try {
    // First build the project
    const { execSync } = require('child_process');
    console.log('   Building project...');
    execSync('npm run build', { stdio: 'inherit' });

    const { PluginManager } = require('./packages/chains/dist/PluginManager.js');
    const pluginManager = new PluginManager();

    // Register Sepolia plugin with broker address
    const config = {
      chainId: 'SEPOLIA',
      rpcUrl: process.env.SEPOLIA_RPC || 'https://eth-sepolia.g.alchemy.com/v2/demo',
      confirmations: 3,
      collectConfirms: 3,
      operator: { address: process.env.SEPOLIA_OPERATOR_ADDRESS || '0xEd3f3F5974599f6455B06bB566C267cc64A6F1d1' },
      hotWalletSeed: process.env.HOT_WALLET_SEED || 'test-seed',
      brokerAddress: process.env.SEPOLIA_BROKER_ADDRESS
    };

    console.log('   Registering plugin with config:', {
      chainId: config.chainId,
      brokerAddress: config.brokerAddress
    });

    await pluginManager.registerPlugin(config);

    const plugin = pluginManager.getPlugin('SEPOLIA');
    console.log('   Plugin registered successfully');

    // Step 3: Test broker availability
    console.log('\n3. BROKER AVAILABILITY CHECK:');
    console.log('   Has swapViaBroker method:', typeof plugin.swapViaBroker === 'function');
    console.log('   Has revertViaBroker method:', typeof plugin.revertViaBroker === 'function');
    console.log('   Has isBrokerAvailable method:', typeof plugin.isBrokerAvailable === 'function');

    if (typeof plugin.isBrokerAvailable === 'function') {
      const isAvailable = plugin.isBrokerAvailable();
      console.log('   isBrokerAvailable() returns:', isAvailable);

      if (!isAvailable && config.brokerAddress) {
        console.log('   ⚠️  WARNING: Broker address configured but isBrokerAvailable returns false!');
        console.log('   This means brokerContract was not initialized properly');
      }
    }

    // Step 4: Simulate Engine's canUseBroker logic
    console.log('\n4. ENGINE canUseBroker() SIMULATION:');
    function canUseBroker(plugin) {
      const hasBrokerMethods = !!(plugin.swapViaBroker && plugin.revertViaBroker);
      console.log('   Has broker methods:', hasBrokerMethods);

      if (!hasBrokerMethods) {
        return false;
      }

      if (typeof plugin.isBrokerAvailable === 'function') {
        const isBrokerConfigured = plugin.isBrokerAvailable();
        console.log('   Is broker configured:', isBrokerConfigured);

        if (!isBrokerConfigured) {
          console.log('   Result: Broker methods exist but broker contract not configured');
        }
        return isBrokerConfigured;
      }

      return true;
    }

    const wouldUseBroker = canUseBroker(plugin);
    console.log('   Engine would use broker:', wouldUseBroker);

    // Step 5: Summary
    console.log('\n5. SUMMARY:');
    if (wouldUseBroker) {
      console.log('   ✅ BROKER IS CONFIGURED AND WILL BE USED');
      console.log('   - Environment variable is set: SEPOLIA_BROKER_ADDRESS=' + process.env.SEPOLIA_BROKER_ADDRESS);
      console.log('   - Plugin initialized broker contract');
      console.log('   - Engine will use broker for swaps/reverts');
    } else {
      console.log('   ❌ BROKER WILL NOT BE USED');
      if (!process.env.SEPOLIA_BROKER_ADDRESS) {
        console.log('   - Missing environment variable: SEPOLIA_BROKER_ADDRESS');
      } else if (!plugin.isBrokerAvailable || !plugin.isBrokerAvailable()) {
        console.log('   - Broker address is set but contract not initialized');
        console.log('   - Check if init() was called properly');
      }
    }

  } catch (error) {
    console.error('   Error during test:', error.message);
  }
}

// Run the test
testBrokerFlow().catch(console.error);