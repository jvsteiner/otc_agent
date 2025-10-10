#!/usr/bin/env node

/**
 * Test script to verify that the frontend correctly displays timeout refund status
 * for deals that are incorrectly marked as CLOSED in the database
 */

// Mock deal data representing a deal with only timeout refunds (no swap payouts)
const mockDealDataTimeoutOnly = {
  stage: 'CLOSED',
  alice: { amount: 100, asset: 'USDT', chainId: 'ETH' },
  bob: { amount: 5, asset: 'ALPHA', chainId: 'UNICITY' },
  transactions: [
    { purpose: 'TIMEOUT_REFUND', status: 'COMPLETED', amount: 100 },
    { purpose: 'OP_COMMISSION', status: 'COMPLETED', amount: 0.3 }
  ]
};

// Mock deal data representing a successful swap
const mockDealDataSuccessfulSwap = {
  stage: 'CLOSED',
  alice: { amount: 100, asset: 'USDT', chainId: 'ETH' },
  bob: { amount: 5, asset: 'ALPHA', chainId: 'UNICITY' },
  transactions: [
    { purpose: 'SWAP_PAYOUT', status: 'COMPLETED', amount: 100 },
    { purpose: 'SWAP_PAYOUT', status: 'COMPLETED', amount: 5 },
    { purpose: 'OP_COMMISSION', status: 'COMPLETED', amount: 0.3 }
  ]
};

// Simulate the getDetailedStatus function logic
function getDetailedStatus(dealData) {
  const aliceExpected = dealData.alice.amount;
  const bobExpected = dealData.bob.amount;
  const aliceAsset = dealData.alice.asset;
  const bobAsset = dealData.bob.asset;
  const aliceChain = dealData.alice.chainId;
  const bobChain = dealData.bob.chainId;

  switch(dealData.stage) {
    case 'CLOSED':
      // Check if this was actually a successful swap or a refund
      const allTransactions = dealData.transactions || [];
      const hasSwapPayouts = allTransactions.some(tx => tx.purpose === 'SWAP_PAYOUT');
      const hasTimeoutRefunds = allTransactions.some(tx => tx.purpose === 'TIMEOUT_REFUND');

      // If there are no swap payouts but there are timeout refunds, this is actually a REVERTED deal
      if (!hasSwapPayouts && hasTimeoutRefunds) {
        return '<strong>Deal cancelled/expired.</strong><br>' +
          'The deal timed out before both parties could fund their escrows.<br>' +
          'Any deposited assets have been returned to payback addresses.';
      }

      // Otherwise it's a successful swap
      return '<strong>Deal completed successfully!</strong><br>' +
        'All assets have been swapped and delivered.<br>' +
        'Alice received ' + bobExpected.toFixed(4) + ' ' + bobAsset + ' on ' + bobChain + '.<br>' +
        'Bob received ' + aliceExpected.toFixed(4) + ' ' + aliceAsset + ' on ' + aliceChain + '.';

    case 'REVERTED':
      return '<strong>Deal cancelled/expired.</strong><br>' +
        'Any deposited assets have been returned to payback addresses.<br>' +
        'You can create a new deal if needed.';

    default:
      return '<strong>Status: ' + dealData.stage + '</strong>';
  }
}

// Test Case 1: Deal with only timeout refunds (should show as cancelled/expired)
console.log('Test 1: Deal with only timeout refunds (incorrectly marked as CLOSED)');
console.log('Expected: Should display "Deal cancelled/expired" message');
const result1 = getDetailedStatus(mockDealDataTimeoutOnly);
if (result1.includes('Deal cancelled/expired')) {
  console.log('✅ PASS - Correctly identifies timeout refund as cancelled deal\n');
} else {
  console.log('❌ FAIL - Still showing as successful swap\n');
}
console.log('Actual output:', result1.replace(/<[^>]*>/g, ''), '\n');

// Test Case 2: Deal with successful swap payouts
console.log('Test 2: Deal with successful swap payouts');
console.log('Expected: Should display "Deal completed successfully" message');
const result2 = getDetailedStatus(mockDealDataSuccessfulSwap);
if (result2.includes('Deal completed successfully')) {
  console.log('✅ PASS - Correctly identifies successful swap\n');
} else {
  console.log('❌ FAIL - Not showing as successful\n');
}
console.log('Actual output:', result2.replace(/<[^>]*>/g, ''), '\n');

console.log('Frontend safeguard test completed!');