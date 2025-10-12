#!/usr/bin/env node

/**
 * Test script to verify internal transaction fetching works correctly
 */

async function testInternalTransactions() {
  console.log('Testing internal transaction fetching...');

  // Test transaction hash from a broker contract call (example)
  const testTxHash = '0x1234567890abcdef'; // Replace with actual tx hash
  const dealId = 'test-deal-123'; // Replace with actual deal ID

  try {
    // Make RPC call to get deal status
    const response = await fetch('http://localhost:8080/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'otc.status',
        params: { dealId },
        id: 1
      })
    });

    const result = await response.json();

    if (result.error) {
      console.error('RPC Error:', result.error);
      return;
    }

    // Check transactions for internal transactions
    const transactions = result.result?.transactions || [];
    console.log(`Found ${transactions.length} transactions for deal ${dealId}`);

    transactions.forEach((tx, index) => {
      console.log(`\nTransaction ${index + 1}:`);
      console.log(`  Purpose: ${tx.purpose}`);
      console.log(`  Chain ID: ${tx.chainId}`);
      console.log(`  TX Hash: ${tx.submittedTx?.txid}`);

      if (tx.internalTransactions) {
        console.log(`  Internal Transactions: ${tx.internalTransactions.length}`);
        tx.internalTransactions.forEach((intTx, intIndex) => {
          console.log(`    [${intIndex}] ${intTx.type}: ${intTx.value} wei`);
          console.log(`         From: ${intTx.from}`);
          console.log(`         To: ${intTx.to}`);
        });
      } else {
        console.log(`  Internal Transactions: None`);
      }
    });

  } catch (error) {
    console.error('Test failed:', error);
  }
}

// Check if running directly
if (require.main === module) {
  console.log('Note: This test requires:');
  console.log('1. The OTC broker server running on port 8080');
  console.log('2. A valid deal ID with broker transactions');
  console.log('3. Replace the example values in the script\n');

  testInternalTransactions();
}