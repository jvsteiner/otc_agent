/**
 * Example: Fetching and displaying internal transactions from broker contract calls
 *
 * This example demonstrates how to use the getInternalTransactions() method
 * to fetch and decode internal transfers from UnicitySwapBroker contract calls.
 */

import { EthereumPlugin } from '../src/EthereumPlugin';
import { ChainConfig } from '../src/ChainPlugin';

async function fetchInternalTransactionsExample() {
  // Initialize the plugin with configuration
  const config: ChainConfig = {
    chainId: 'ETH',
    rpcUrl: 'https://eth-rpc.publicnode.com',
    confirmations: 12,
    collectConfirms: 12,
    operator: {
      address: '0x1234567890123456789012345678901234567890', // Replace with your operator address
    },
    brokerAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12', // Replace with your broker contract address
    etherscanApiKey: process.env.ETHERSCAN_API_KEY, // Set via environment variable
  };

  const plugin = new EthereumPlugin();
  await plugin.init(config);

  // Example transaction hash (replace with actual broker transaction)
  const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

  console.log(`\nFetching internal transactions for: ${txHash}\n`);

  try {
    // Fetch internal transactions
    const internalTxs = await plugin.getInternalTransactions(txHash);

    if (internalTxs.length === 0) {
      console.log('No internal transactions found.');
      console.log('Possible reasons:');
      console.log('  - Transaction has no internal calls');
      console.log('  - API key not configured');
      console.log('  - Transaction not yet indexed by Etherscan');
      return;
    }

    console.log(`Found ${internalTxs.length} internal transaction(s):\n`);

    // Display each internal transaction
    internalTxs.forEach((tx, index) => {
      console.log(`Transfer #${index + 1}:`);
      console.log(`  Type:  ${tx.type.toUpperCase()}`);
      console.log(`  From:  ${tx.from}`);
      console.log(`  To:    ${tx.to}`);
      console.log(`  Value: ${tx.value} ETH`);
      console.log('');
    });

    // Analyze the transaction pattern
    analyzeTransferPattern(internalTxs);

  } catch (error) {
    console.error('Error fetching internal transactions:', error);
  }
}

/**
 * Analyze and describe the transfer pattern
 */
function analyzeTransferPattern(
  internalTxs: Array<{
    from: string;
    to: string;
    value: string;
    type: 'swap' | 'fee' | 'refund' | 'unknown';
  }>
) {
  console.log('Transaction Analysis:');
  console.log('─'.repeat(60));

  const swapTransfers = internalTxs.filter(tx => tx.type === 'swap');
  const feeTransfers = internalTxs.filter(tx => tx.type === 'fee');
  const refundTransfers = internalTxs.filter(tx => tx.type === 'refund');

  if (swapTransfers.length > 0) {
    console.log('✓ Swap Execution Detected');
    console.log(`  → Recipient received: ${swapTransfers[0].value} ETH`);
  }

  if (feeTransfers.length > 0) {
    console.log('✓ Commission Payment');
    console.log(`  → Operator earned: ${feeTransfers[0].value} ETH`);
  }

  if (refundTransfers.length > 0) {
    const totalRefund = refundTransfers.reduce(
      (sum, tx) => sum + parseFloat(tx.value),
      0
    );
    console.log('✓ Refund/Surplus');
    console.log(`  → Payback received: ${totalRefund.toFixed(8)} ETH`);
  }

  // Determine transaction type
  let txType = 'Unknown';
  if (swapTransfers.length > 0 && feeTransfers.length > 0) {
    txType = 'Successful Swap with Commission';
  } else if (swapTransfers.length > 0) {
    txType = 'Swap (No Commission)';
  } else if (feeTransfers.length > 0 && refundTransfers.length > 0) {
    txType = 'Revert/Refund with Commission';
  } else if (refundTransfers.length > 0) {
    txType = 'Simple Refund';
  }

  console.log(`\nTransaction Type: ${txType}`);
  console.log('─'.repeat(60));
}

/**
 * Example: Display transaction details for GUI
 */
function formatForGUI(
  txHash: string,
  internalTxs: Array<{
    from: string;
    to: string;
    value: string;
    type: 'swap' | 'fee' | 'refund' | 'unknown';
  }>
) {
  return {
    txHash,
    timestamp: new Date().toISOString(),
    transfers: internalTxs.map(tx => ({
      type: tx.type,
      recipient: tx.to,
      amount: tx.value,
      currency: 'ETH', // or detect from chain
      description: getTransferDescription(tx.type),
    })),
  };
}

function getTransferDescription(type: 'swap' | 'fee' | 'refund' | 'unknown'): string {
  const descriptions = {
    swap: 'Swap payout to recipient',
    fee: 'Commission payment to operator',
    refund: 'Surplus/refund to sender',
    unknown: 'Unknown transfer',
  };
  return descriptions[type];
}

// Example usage for different transaction types
function exampleUsageScenarios() {
  console.log('\n' + '='.repeat(60));
  console.log('USAGE SCENARIOS');
  console.log('='.repeat(60) + '\n');

  console.log('Scenario 1: Successful Swap with Commission');
  console.log('  Expected internal transactions:');
  console.log('    1. swap   → Recipient gets trade amount');
  console.log('    2. fee    → Operator gets commission');
  console.log('    3. refund → Sender gets surplus (if any)');
  console.log('');

  console.log('Scenario 2: Revert/Timeout with Commission');
  console.log('  Expected internal transactions:');
  console.log('    1. fee    → Operator gets commission');
  console.log('    2. refund → Sender gets original deposit back');
  console.log('');

  console.log('Scenario 3: Simple Swap (No Commission)');
  console.log('  Expected internal transactions:');
  console.log('    1. swap   → Recipient gets full trade amount');
  console.log('');

  console.log('Scenario 4: Post-Deal Refund');
  console.log('  Expected internal transactions:');
  console.log('    1. fee    → Operator gets commission (if any)');
  console.log('    2. refund → Late depositor gets refund');
  console.log('');
}

// Run the example
if (require.main === module) {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║   Internal Transactions Fetching Example                 ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  // Show usage scenarios
  exampleUsageScenarios();

  // Run the fetch example (will fail without real transaction hash and API key)
  console.log('\n' + '='.repeat(60));
  console.log('FETCH EXAMPLE');
  console.log('='.repeat(60) + '\n');

  console.log('To run this example:');
  console.log('  1. Set ETHERSCAN_API_KEY environment variable');
  console.log('  2. Update config with your broker contract address');
  console.log('  3. Replace txHash with a real broker transaction');
  console.log('  4. Run: npx ts-node examples/fetch-internal-transactions.ts');
  console.log('');

  // Uncomment to run actual fetch (requires valid config)
  // fetchInternalTransactionsExample().catch(console.error);
}

export {
  fetchInternalTransactionsExample,
  formatForGUI,
  analyzeTransferPattern,
};
