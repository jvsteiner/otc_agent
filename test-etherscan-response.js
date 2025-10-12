/**
 * Test Etherscan API response parsing to identify the issue
 */

const TEST_TX_HASH = '0xe17484460dc5e5956cc970657cf8bbcff38b95567f89ddb98562800158ca4be6';
const API_KEY = 'DPQVJRXDTY8411MACGQXRA8KP5VB832UQ5';
const API_URL = 'https://api-sepolia.etherscan.io/api';

async function testRawFetch() {
  console.log('\n=== Testing Raw Fetch ===');

  const params = new URLSearchParams({
    module: 'account',
    action: 'txlistinternal',
    txhash: TEST_TX_HASH,
  });

  if (API_KEY) {
    params.append('apikey', API_KEY);
  }

  const url = `${API_URL}?${params.toString()}`;
  console.log(`\nFetching: ${url}`);

  const response = await fetch(url);
  console.log(`Response status: ${response.status}`);
  console.log(`Response ok: ${response.ok}`);

  const data = await response.json();

  console.log('\nRaw response:');
  console.log(JSON.stringify(data, null, 2));

  console.log('\nResponse analysis:');
  console.log(`  data.status: ${data.status} (type: ${typeof data.status})`);
  console.log(`  data.message: ${data.message}`);
  console.log(`  data.result type: ${typeof data.result}`);
  console.log(`  Array.isArray(data.result): ${Array.isArray(data.result)}`);
  console.log(`  data.result.length: ${data.result?.length}`);

  // Check the conditions from EtherscanAPI.ts line 318
  console.log('\nCondition checks:');
  console.log(`  data.status === '1': ${data.status === '1'}`);
  console.log(`  Array.isArray(data.result): ${Array.isArray(data.result)}`);
  console.log(`  Both conditions: ${data.status === '1' && Array.isArray(data.result)}`);

  if (data.status === '1' && Array.isArray(data.result)) {
    console.log('\n✓ Would enter the success branch');
    console.log(`  Processing ${data.result.length} transactions`);

    // Simulate the mapping logic
    const { ethers } = require('ethers');
    const processed = data.result.map((tx) => ({
      from: tx.from,
      to: tx.to,
      value: ethers.formatEther(tx.value),
      type: tx.type,
      isError: tx.isError === '1'
    }));

    console.log('\nProcessed transactions:');
    processed.forEach((tx, idx) => {
      console.log(`\n[${idx}]:`);
      console.log(`  from: ${tx.from}`);
      console.log(`  to: ${tx.to}`);
      console.log(`  value: ${tx.value}`);
      console.log(`  type: ${tx.type}`);
      console.log(`  isError: ${tx.isError}`);
    });

    return processed;
  } else if (data.message === 'No transactions found') {
    console.log('\n✗ Would return empty array (no transactions found)');
    return [];
  } else {
    console.log('\n✗ Would return empty array (other condition)');
    console.log(`  Message: ${data.message}`);
    return [];
  }
}

async function main() {
  console.log('====================================');
  console.log('Etherscan API Response Test');
  console.log('====================================');

  try {
    await testRawFetch();
  } catch (error) {
    console.error('\nError:', error);
  }

  console.log('\n====================================');
  console.log('Test Complete');
  console.log('====================================\n');
}

main().catch(console.error);
