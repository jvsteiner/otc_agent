/**
 * Debug script to test internal transaction fetching for Sepolia
 * Tests the complete flow from Etherscan API to EthereumPlugin filtering
 */

const { EthereumPlugin } = require('./packages/chains/dist/EthereumPlugin');
const { EtherscanAPI } = require('./packages/chains/dist/utils/EtherscanAPI');

const TEST_TX_HASH = '0xe17484460dc5e5956cc970657cf8bbcff38b95567f89ddb98562800158ca4be6';
const BROKER_CONTRACT = '0x4C164Af901b7cdC1864c91E3aB873E5Cf8DCE808';
const ETHERSCAN_API_KEY = 'DPQVJRXDTY8411MACGQXRA8KP5VB832UQ5';

async function testEtherscanAPI() {
  console.log('\n=== Testing Etherscan API directly ===');

  const etherscanAPI = new EtherscanAPI('SEPOLIA', ETHERSCAN_API_KEY);

  try {
    const internalTxs = await etherscanAPI.getInternalTransactions(TEST_TX_HASH);

    console.log(`\nEtherscan API returned ${internalTxs.length} internal transactions:`);
    internalTxs.forEach((tx, idx) => {
      console.log(`\n[${idx}] Internal Transaction:`);
      console.log(`  From: ${tx.from}`);
      console.log(`  To: ${tx.to}`);
      console.log(`  Value: ${tx.value} ETH`);
      console.log(`  Type: ${tx.type}`);
      console.log(`  IsError: ${tx.isError}`);
    });

    return internalTxs;
  } catch (error) {
    console.error('Error fetching from Etherscan API:', error);
    return [];
  }
}

async function testEthereumPlugin() {
  console.log('\n=== Testing EthereumPlugin.getInternalTransactions ===');

  // Initialize plugin with minimal config
  const config = {
    chainId: 'SEPOLIA',
    rpcUrl: process.env.SEPOLIA_RPC || 'https://rpc.sepolia.org',
    confirmations: 3,
    collectConfirms: 3,
    brokerContract: BROKER_CONTRACT,
    etherscanApiKey: ETHERSCAN_API_KEY
  };

  const plugin = new EthereumPlugin(config);

  try {
    await plugin.init();

    console.log('\nPlugin initialized successfully');
    console.log(`Broker contract: ${BROKER_CONTRACT}`);

    const internalTxs = await plugin.getInternalTransactions(TEST_TX_HASH);

    console.log(`\nPlugin returned ${internalTxs.length} classified internal transactions:`);
    internalTxs.forEach((tx, idx) => {
      console.log(`\n[${idx}] Classified Transaction:`);
      console.log(`  From: ${tx.from}`);
      console.log(`  To: ${tx.to}`);
      console.log(`  Value: ${tx.value} ETH`);
      console.log(`  Type: ${tx.type}`);
    });

    return internalTxs;
  } catch (error) {
    console.error('Error with EthereumPlugin:', error);
    return [];
  }
}

async function analyzeFiltering(rawTxs) {
  console.log('\n=== Analyzing Filtering Logic ===');

  const brokerLower = BROKER_CONTRACT.toLowerCase();
  console.log(`\nBroker address (lowercase): ${brokerLower}`);

  rawTxs.forEach((tx, idx) => {
    const fromLower = tx.from.toLowerCase();
    const isFromBroker = fromLower === brokerLower;
    const hasValue = parseFloat(tx.value) > 0;
    const willPass = isFromBroker && hasValue && !tx.isError;

    console.log(`\n[${idx}] Filter Analysis:`);
    console.log(`  From: ${tx.from}`);
    console.log(`  From (lower): ${fromLower}`);
    console.log(`  Is from broker: ${isFromBroker}`);
    console.log(`  Has value (${tx.value}): ${hasValue}`);
    console.log(`  Not error: ${!tx.isError}`);
    console.log(`  WILL PASS FILTER: ${willPass}`);
  });
}

async function main() {
  console.log('====================================');
  console.log('Internal Transaction Debug Script');
  console.log('====================================');
  console.log(`\nTransaction: ${TEST_TX_HASH}`);
  console.log(`Broker Contract: ${BROKER_CONTRACT}`);
  console.log(`API Key: ${ETHERSCAN_API_KEY.substring(0, 10)}...`);

  // Test 1: Direct Etherscan API call
  const rawTxs = await testEtherscanAPI();

  // Test 2: Analyze filtering
  if (rawTxs.length > 0) {
    await analyzeFiltering(rawTxs);
  }

  // Test 3: Full plugin test
  await testEthereumPlugin();

  console.log('\n====================================');
  console.log('Debug Complete');
  console.log('====================================\n');
}

// Run the debug script
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
